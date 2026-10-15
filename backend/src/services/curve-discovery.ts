/**
 * Curve factory sweep — the on-chain pool registry IS the discovery
 * source (Curve on Stellar has no REST index yet). Walks
 * factory.pool_registration(0..pool_count), reads each pool's live
 * balances, and derives token metadata from the coins themselves.
 *
 * Runs on the discovery cadence (10 min) and costs ~3 simulations per
 * pool + 2 per never-seen coin, so it stays negligible even at dozens of
 * pools. Token metadata is cached for the process lifetime (immutable).
 */

import { StellarClient } from '../stellar/client.js';
import type { DiscoveredCurvePool } from '../venues/curve.js';
import type { AggregatedToken } from './token-discovery.js';

/** Registry walk cap per sweep — mirrors the adapter contract's bound. */
const MAX_POOLS = parseInt(process.env.CURVE_MAX_POOLS ?? '64');

const tokenMetaCache = new Map<string, { symbol: string; name: string; issuer: string }>();

/** SAC name() is "CODE:GISSUER" for classic assets; Soroban-native tokens
 *  return a free-form name. */
export function parseSacName(name: string): { code: string; issuer: string } | null {
  const m = /^([A-Za-z0-9]{1,12}):(G[A-Z2-7]{55})$/.exec(name);
  return m ? { code: m[1], issuer: m[2] } : null;
}

export async function sweepCurveFactory(
  stellar: StellarClient,
  factory: string
): Promise<{ pools: DiscoveredCurvePool[]; tokens: AggregatedToken[] }> {
  const pools: DiscoveredCurvePool[] = [];
  const tokens = new Map<string, AggregatedToken>();

  const count = await stellar.simulateAndParse<number>(factory, 'pool_count', []);
  const n = Math.min(Number(count ?? 0), MAX_POOLS);

  for (let idx = 0; idx < n; idx++) {
    const reg = await stellar.simulateAndParse<any>(factory, 'pool_registration', [
      StellarClient.toU32(idx),
    ]);
    const pool: string | undefined = reg?.pool ? String(reg.pool) : undefined;
    const coins: string[] = Array.isArray(reg?.coins) ? reg.coins.map(String) : [];
    if (!pool || coins.length < 2) continue;
    const decimals: number[] = Array.isArray(reg?.coin_decimals)
      ? reg.coin_decimals.map((d: unknown) => Number(d))
      : coins.map(() => 7);

    const [balancesRaw, name] = await Promise.all([
      stellar.simulateAndParse<bigint[]>(pool, 'get_balances', []),
      stellar.simulateAndParse<string>(pool, 'name', []),
    ]);
    const balances = Array.isArray(balancesRaw)
      ? balancesRaw.map((b) => BigInt(b as any).toString())
      : coins.map(() => '0');

    pools.push({
      poolAddress: pool,
      coins,
      decimals,
      balances,
      ...(name ? { name: String(name) } : {}),
    });

    for (let k = 0; k < coins.length; k++) {
      const sac = coins[k];
      if (tokens.has(sac)) continue;
      let meta = tokenMetaCache.get(sac);
      if (!meta) {
        const [sym, nm] = await Promise.all([
          stellar.simulateAndParse<string>(sac, 'symbol', []),
          stellar.simulateAndParse<string>(sac, 'name', []),
        ]);
        if (!sym) continue;
        const parsed = parseSacName(String(nm ?? ''));
        meta = {
          symbol: String(sym),
          name: parsed ? parsed.code : String(nm ?? sym),
          issuer: parsed ? parsed.issuer : '',
        };
        tokenMetaCache.set(sac, meta);
      }
      if (meta.symbol.length > 32) continue;
      tokens.set(sac, {
        symbol: meta.symbol,
        name: meta.name,
        issuer: meta.issuer,
        sacAddress: sac,
        decimals: decimals[k] ?? 7,
        status: 'live',
        source: 'curve',
        verified: false,
        venueVolume: 0,
      });
    }
  }

  return { pools, tokens: [...tokens.values()] };
}
