/**
 * Venue registry — central place to register and access all venue adapters.
 */

import { VenueAdapter } from './adapter.js';
import { SwapBookAdapter } from './swapbook.js';
import { AquaAdapter, AquaPoolsProvider } from './aqua.js';
import { SushiSwapAdapter, SushiPairsProvider } from './sushiswap.js';
import { StellarDexAdapter } from './stellar-dex.js';
import { StellarClient } from '../stellar/client.js';
import { QuoteCurveCache } from '../services/quote-curve-cache.js';

/** Availability is a health signal, not per-quote data — memoize it.
 *  Un-memoized, every computeRoute (per hop, per candidate path) paid an
 *  Aqua HTTP health check plus a Horizon ledger fetch before quoting. */
const AVAILABILITY_TTL_MS = parseInt(
  process.env.VENUE_AVAILABILITY_TTL_MS ?? '30000'
);

export class VenueRegistry {
  private venues: Map<number, VenueAdapter> = new Map();
  private availableMemo: { ts: number; val: VenueAdapter[] } | null = null;
  private availableInFlight: Promise<VenueAdapter[]> | null = null;

  register(adapter: VenueAdapter): void {
    this.venues.set(adapter.venueId, adapter);
    console.log(`  Venue registered: ${adapter.name} (id=${adapter.venueId})`);
  }

  get(venueId: number): VenueAdapter | undefined {
    return this.venues.get(venueId);
  }

  getAll(): VenueAdapter[] {
    return Array.from(this.venues.values());
  }

  async getAvailable(): Promise<VenueAdapter[]> {
    if (
      this.availableMemo &&
      Date.now() - this.availableMemo.ts < AVAILABILITY_TTL_MS
    ) {
      return this.availableMemo.val;
    }
    if (this.availableInFlight) return this.availableInFlight;
    this.availableInFlight = (async () => {
      try {
        const all = this.getAll();
        const checks = await Promise.all(
          all.map(async (v) => ({
            adapter: v,
            available: await v.isAvailable().catch(() => false),
          }))
        );
        const val = checks.filter((c) => c.available).map((c) => c.adapter);
        // An empty result is not memoized: a transient outage should not
        // blank every venue for a whole TTL window.
        if (val.length > 0) this.availableMemo = { ts: Date.now(), val };
        return val;
      } finally {
        this.availableInFlight = null;
      }
    })();
    return this.availableInFlight;
  }
}

export function createVenueRegistry(config: {
  swapbookContractId: string;
  aquaAdapterContractId: string;
  aquaApiUrl: string;
  sushiAdapterContractId: string;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Live Sushi pair source (token discovery); env SUSHI_PAIRS overrides */
  sushiPairsProvider?: SushiPairsProvider;
  /** Discovered Aqua pools per pair (token discovery) — quoting source */
  aquaPoolsProvider?: AquaPoolsProvider;
}): VenueRegistry {
  const registry = new VenueRegistry();

  // Shared Stellar RPC client
  const stellar = new StellarClient({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  });

  // Shared depth-curve cache (the hybrid quoting layer): pool quote
  // curves are sampled once per TTL and shared across depth levels,
  // candidate paths, hops and repeat quotes. QUOTE_CURVE_DISABLE=1
  // restores per-amount simulation (rollback / benchmarking knob).
  const curveCache = ['1', 'true'].includes(
    (process.env.QUOTE_CURVE_DISABLE ?? '').toLowerCase()
  )
    ? undefined
    : new QuoteCurveCache();

  if (config.swapbookContractId) {
    registry.register(new SwapBookAdapter(config.swapbookContractId, stellar));
  }

  if (config.aquaAdapterContractId) {
    registry.register(
      new AquaAdapter(
        config.aquaAdapterContractId,
        config.aquaApiUrl,
        stellar,
        config.aquaPoolsProvider,
        curveCache
      )
    );
  }

  if (config.sushiAdapterContractId) {
    registry.register(
      new SushiSwapAdapter(
        config.sushiAdapterContractId,
        stellar,
        process.env.SUSHI_PAIRS,
        config.sushiPairsProvider
      )
    );
  }

  // Stellar DEX — always available, uses Horizon (no contract needed)
  if (config.horizonUrl) {
    registry.register(new StellarDexAdapter(config.horizonUrl, curveCache));
  }

  return registry;
}

// Interfaces must re-export as types — Node's native TS stripping (and any
// isolatedModules build) errors on value re-exports of type-only names.
export type { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
