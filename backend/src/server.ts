/**
 * AtomicSwap Aggregator — Backend Server
 *
 * Express server providing:
 * - GET  /api/quote           — Get best route for an instant swap
 * - GET  /api/orders          — Get open orders for a token pair
 * - POST /api/swap/build      — Build an unsigned instant swap transaction
 * - POST /api/peer-swap/build — Build a peer swap (auto-match + escrow remainder)
 * - GET  /api/assets          — List supported assets
 * - GET  /api/health          — Health check
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Asset, TransactionBuilder } from '@stellar/stellar-sdk';
import { RoutingEngine } from './router/engine.js';
import { Pathfinder, PathResult } from './router/pathfinder.js';
import { createVenueRegistry } from './venues/index.js';
import { StellarClient, scEnum } from './stellar/client.js';
import { TOKENS, resolveToken, resolveSacAddress } from './stellar/tokens.js';
import { OraclePriceService } from './services/oracle.js';
import { TimerSweepService } from './services/timer-sweep.js';
import { assertNotBlocked, isBlocked, BlockedAddressError } from './services/screening.js';
import { Sep1Verifier } from './services/sep1-verify.js';
import { FairValueService } from './services/fair-value.js';
import { TokenDiscoveryService } from './services/token-discovery.js';
import { TwapKeeperService } from './services/twap-keeper.js';

const app = express();
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',')
    : ['http://localhost:3000', 'http://localhost:3001'],
  credentials: true,
}));
app.use(express.json({ limit: '100kb' }));
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    limit: 120, // per IP per minute
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// ─── Configuration ──────────────────────────────────────

const config = {
  port: parseInt(process.env.PORT ?? '3001'),
  rpcUrl: process.env.SOROBAN_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  networkPassphrase: process.env.NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  swapbookContractId: process.env.SWAPBOOK_CONTRACT_ID ?? '',
  routerContractId: process.env.ROUTER_CONTRACT_ID ?? '',
  feeVaultContractId: process.env.FEE_VAULT_CONTRACT_ID ?? '',
  aquaAdapterContractId: process.env.AQUA_ADAPTER_CONTRACT_ID ?? '',
  aquaApiUrl: process.env.AQUA_API_URL ?? 'https://amm-api-testnet.aqua.network/api/external/v1',
  sushiAdapterContractId: process.env.SUSHI_ADAPTER_CONTRACT_ID ?? '',
  twapBookContractId: process.env.TWAP_BOOK_CONTRACT_ID ?? '',
  horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  /**
   * v1.1 SwapBook features (match_and_place, excluded counterparties).
   * Leave unset while the deployed SwapBook is v1.0 — the extra arg /
   * new entry point would fail against it. Flip after deploying v1.1
   * and updating SWAPBOOK_CONTRACT_ID.
   */
  swapbookV11: ['1', 'true'].includes((process.env.SWAPBOOK_V11 ?? '').toLowerCase()),
  /** v1.2 Router deployed: multi-hop executes as ONE atomic execute_path
   *  transaction instead of a signed-per-leg blend plan. */
  routerV12: ['1', 'true'].includes((process.env.ROUTER_V12 ?? '').toLowerCase()),
};

/**
 * Protocol-operated liquidity wallets (e.g. SDF-supported inventory).
 * Two effects: (1) peer-swap plans route takers to ORGANIC makers first
 * and only fall back to these wallets, so growing volume naturally
 * displaces them; (2) with v1.1, orders placed FROM one of these wallets
 * automatically exclude the others on-chain, so the liquidity can never
 * cross itself.
 */
const SDF_LIQUIDITY_WALLETS = (process.env.SDF_LIQUIDITY_WALLETS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * P2P (SwapBook) is scoped to this corridor. The on-chain book is
 * asset-agnostic — this is a product-level gate, enforced here so the UI
 * restriction can't be bypassed by calling the API directly.
 */
const P2P_ALLOWED_TOKENS = (process.env.P2P_ALLOWED_TOKENS ?? 'USDC,USDT0')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

function assertP2pAllowed(raw: unknown, field: string): void {
  // Resolve through the curated registry first, then the discovery
  // universe — corridor tokens like deJAAA/deJTRSY are venue-discovered
  // (Soroban-native, no curated entry) and arrive as SAC addresses.
  let symbol: string | undefined =
    typeof raw === 'string' ? resolveToken(raw)?.symbol : undefined;
  if (!symbol && typeof raw === 'string') {
    const upper = raw.toUpperCase();
    symbol = tokenDiscovery
      .getTokens()
      .find(
        (t) => t.sacAddress === raw || t.symbol.toUpperCase() === upper
      )?.symbol;
  }
  if (!symbol || !P2P_ALLOWED_TOKENS.includes(symbol.toUpperCase())) {
    throw new BadRequest(
      `${field}: P2P swaps are limited to ${P2P_ALLOWED_TOKENS.join(', ')}`
    );
  }
}

/** Ledgers per second on Stellar (approx). */
const LEDGER_SECONDS = 5;
/** Default order lifetime if the caller doesn't pass an expiry (~7 days). */
const DEFAULT_EXPIRY_LEDGERS = Math.floor((7 * 24 * 3600) / LEDGER_SECONDS);

// ─── Input validation helpers ───────────────────────────

class BadRequest extends Error {}

function parseAmount(value: unknown, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequest(`${field} is required`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch {
    throw new BadRequest(`${field} must be an integer amount in base units`);
  }
  if (parsed <= 0n) throw new BadRequest(`${field} must be positive`);
  if (parsed > 10n ** 26n) throw new BadRequest(`${field} is implausibly large`);
  return parsed;
}

function parseSlippageBps(value: unknown, fallback = 50): number {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new BadRequest('slippage must be an integer between 1 and 1000 bps');
  }
  return n;
}

function parseStellarAccount(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^G[A-Z2-7]{55}$/.test(value)) {
    throw new BadRequest(`${field} must be a Stellar account address`);
  }
  return value;
}

function resolveTokenParam(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequest(`${field} is required`);
  }
  try {
    return resolveSacAddress(value);
  } catch (err) {
    throw new BadRequest((err as Error).message);
  }
}

/**
 * Translate an on-chain simulation failure into a message a user can act
 * on. Returns null for anything that isn't a recognizable sim failure —
 * those keep the generic label (and the full detail in the logs).
 */
function explainSimError(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const m = error.message;
  if (!/simulation failed/i.test(m)) return null;
  const code = m.match(/Error\(Contract, #(\d+)\)/)?.[1];
  if (/resulting balance is not within the allowed range/i.test(m)) {
    return 'Insufficient balance: this swap would overdraw one of your tokens. Lower the amount and try again.';
  }
  if (/trustline.*(missing|not found)|missing.*trustline/i.test(m)) {
    return 'Your wallet is missing a trustline for one of the assets in this swap.';
  }
  if (code === '6') {
    return 'A venue on this route has no registered pool for the pair yet — try again shortly or pick a different pair.';
  }
  return `The swap was rejected in on-chain simulation (contract error #${code ?? 'unknown'}). No funds were moved.`;
}

function handleError(res: express.Response, error: unknown, label: string): void {
  if (error instanceof BadRequest) {
    res.status(400).json({ error: error.message });
    return;
  }
  if (error instanceof BlockedAddressError) {
    res.status(403).json({ error: error.message });
    return;
  }
  const explained = explainSimError(error);
  if (explained) {
    console.error(`${label} (sim):`, error instanceof Error ? error.message.slice(0, 2000) : error);
    res.status(400).json({ error: explained });
    return;
  }
  console.error(`${label}:`, error);
  res.status(500).json({ error: label });
}

// ─── Initialize Services ────────────────────────────────

console.log('AtomicSwap Aggregator starting...');
console.log(`  RPC: ${config.rpcUrl}`);
console.log(`  Network: ${config.networkPassphrase}`);
console.log('');
console.log('Contracts:');
console.log(`  SwapBook: ${config.swapbookContractId || '(not set)'}`);
console.log(`  Router:   ${config.routerContractId || '(not set)'}`);
console.log(`  FeeVault: ${config.feeVaultContractId || '(not set)'}`);
console.log(`  Aqua:     ${config.aquaAdapterContractId || '(not set)'}`);
console.log(`  Sushi:    ${config.sushiAdapterContractId || '(not set)'}`);
console.log('');

const stellar = new StellarClient({
  rpcUrl: config.rpcUrl,
  networkPassphrase: config.networkPassphrase,
});

// Token discovery must exist before the venue registry so the Sushi
// adapter can read its live pair table.
const tokenDiscovery = new TokenDiscoveryService({
  aquaApiUrl: config.aquaApiUrl,
  sushiGraphqlUrl:
    process.env.SUSHI_GRAPHQL_URL ??
    'https://production.data-gcp.sushi.com/api/graphql',
  intervalMs: 10 * 60 * 1000, // 10 minutes
  minTxCount: parseInt(process.env.DISCOVERY_MIN_TX_COUNT ?? '10'),
  minSushiLiquidityUsd: parseInt(process.env.SUSHI_MIN_LIQUIDITY_USD ?? '500'),
  // Soroban-native tokens carry their own decimals (SolvBTC: 8) — read
  // from the contract instead of assuming Stellar's classic 7
  readDecimals: (sac) => stellar.simulateAndParse<number>(sac, 'decimals', []),
});
tokenDiscovery.start();

console.log('Registering venues:');
const registry = createVenueRegistry({
  swapbookContractId: config.swapbookContractId,
  aquaAdapterContractId: config.aquaAdapterContractId,
  aquaApiUrl: config.aquaApiUrl,
  sushiAdapterContractId: config.sushiAdapterContractId,
  horizonUrl: config.horizonUrl,
  rpcUrl: config.rpcUrl,
  networkPassphrase: config.networkPassphrase,
  sushiPairsProvider: () => tokenDiscovery.getSushiPairs(),
  aquaPoolsProvider: (a, b) => tokenDiscovery.getPoolsForPair(a, b),
});
console.log('');

const routingEngine = new RoutingEngine(registry);
// Multi-hop pathfinder (deferred init: needs decimalsForSac, defined below)
let pathfinder: Pathfinder;

// Oracle fair-value reads (RedStone + Reflector) for quote honesty
const fairValue = new FairValueService(stellar);

// ─── Background Services ───────────────────────────────

const oracleService = new OraclePriceService({
  stellar,
  swapbookContractId: config.swapbookContractId,
  intervalMs: 5 * 60 * 1000, // 5 minutes
  oracleSecretKey: process.env.ORACLE_SECRET_KEY,
});
oracleService.start();

pathfinder = new Pathfinder(
  tokenDiscovery,
  routingEngine,
  stellar,
  (sac) => decimalsForSac(sac)
);

// SEP-1 issuer-domain handshake: earns the green verified badge for
// venue-discovered classic assets automatically. First sweep runs after
// discovery has populated (90s), then every 6h; verdicts cached 24h.
const sep1 = new Sep1Verifier(config.horizonUrl);
const runSep1Sweep = async () => {
  const targets = tokenDiscovery
    .getTokens()
    .filter((t) => t.issuer && !t.homeDomain)
    .map((t) => ({ symbol: t.symbol, issuer: t.issuer }));
  if (targets.length === 0) return;
  const n = await sep1.sweep(targets);
  console.log(`[SEP1] swept ${targets.length} issuers, ${n} verified domains`);
};
setTimeout(() => runSep1Sweep().catch(() => {}), 90_000);
setInterval(() => runSep1Sweep().catch(() => {}), 6 * 60 * 60 * 1000);

const timerSweep = new TimerSweepService({
  stellar,
  swapbookContractId: config.swapbookContractId,
  routerContractId: config.routerContractId,
  routingEngine,
  intervalMs: 60 * 1000, // 60 seconds
  keeperSecretKey: process.env.KEEPER_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY,
});
timerSweep.start();

const twapKeeper = new TwapKeeperService({
  stellar,
  twapBookContractId: config.twapBookContractId,
  routingEngine,
  intervalMs: 30 * 1000, // 30 seconds
  keeperSecretKey: process.env.KEEPER_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY,
  // Opportunistic slice sizing: fill to the pace ceiling when the market
  // is at/near oracle fair value (hoisted fns — resolved at tick time)
  fairValue,
  tokenMeta: (sac) => ({ decimals: decimalsForSac(sac), symbol: symbolForSac(sac) }),
});
twapKeeper.start();

// ─── Shared order helpers ───────────────────────────────

interface ChainOrder {
  id: number;
  maker: string;
  status: string;
  amountIn: bigint;
  amountInRemaining: bigint;
  minAmountOut: bigint;
  expiry: number;
  priceMode: string;
  /** v1.1: addresses that may not fill this order (empty on v1.0 orders) */
  excluded: string[];
  raw: any;
}

function normalizeOrder(raw: any): ChainOrder | null {
  if (!raw) return null;
  try {
    return {
      id: Number(raw.id),
      maker: String(raw.maker),
      status: scEnum(raw.status),
      amountIn: BigInt(raw.amount_in ?? 0),
      amountInRemaining: BigInt(raw.amount_in_remaining ?? 0),
      minAmountOut: BigInt(raw.min_amount_out ?? 0),
      expiry: Number(raw.expiry ?? 0),
      priceMode: scEnum(raw.price_mode),
      excluded: Array.isArray(raw.excluded) ? raw.excluded.map(String) : [],
      raw,
    };
  } catch {
    return null;
  }
}

function isOpen(order: ChainOrder): boolean {
  return order.status === 'Open' || order.status === 'PartialFill';
}

async function fetchOrdersForPair(
  tokenInSac: string,
  tokenOutSac: string
): Promise<ChainOrder[]> {
  const orderIds = await stellar.simulateAndParse<Array<number | bigint>>(
    config.swapbookContractId,
    'get_orders',
    [StellarClient.toAddress(tokenInSac), StellarClient.toAddress(tokenOutSac)]
  );
  if (!orderIds || orderIds.length === 0) return [];

  const orders = await Promise.all(
    orderIds.map((id) =>
      stellar.simulateAndParse<any>(config.swapbookContractId, 'get_order', [
        StellarClient.toU64(BigInt(id)),
      ])
    )
  );
  return orders.map(normalizeOrder).filter((o): o is ChainOrder => o !== null);
}

function orderToJson(order: ChainOrder, extra: Record<string, unknown> = {}) {
  return {
    id: order.id,
    maker: order.maker,
    status: order.status,
    amountIn: order.amountIn.toString(),
    amountInRemaining: order.amountInRemaining.toString(),
    minAmountOut: order.minAmountOut.toString(),
    expiry: order.expiry,
    priceMode: order.priceMode,
    ...extra,
  };
}


/** Symbol for a SAC from the discovery universe ('' if unknown). */
function symbolForSac(sac: string): string {
  return tokenDiscovery.getTokens().find((t) => t.sacAddress === sac)?.symbol ?? '';
}

/** Human-readable chain for a multi-hop path: "SolvBTC → XLM → USDC". */
function pathLabel(path: string[]): string {
  return path.map((sac) => symbolForSac(sac) || sac.slice(0, 4)).join(' → ');
}

/** Token decimals by SAC address from the discovery universe (default 7). */
function decimalsForSac(sac: string): number {
  return tokenDiscovery.getTokens().find((t) => t.sacAddress === sac)?.decimals ?? 7;
}

/** ceil(a * b / d) for bigints — mirrors the contract's rounding. */
function muldivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

// ─── Classic SDEX swap building ─────────────────────────

const XLM_SAC = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';

function classicAssetFor(sacOrSymbol: string): InstanceType<typeof Asset> {
  if (sacOrSymbol === XLM_SAC || sacOrSymbol.toUpperCase() === 'XLM') {
    return Asset.native();
  }
  const cfg = resolveToken(sacOrSymbol);
  if (!cfg?.issuer) {
    throw new BadRequest(`No classic asset known for ${sacOrSymbol}`);
  }
  return new Asset(cfg.symbol, cfg.issuer);
}

function toDisplay7(base: bigint): string {
  const whole = base / 10000000n;
  const frac = (base % 10000000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

/** Build an unsigned classic path-payment-strict-send for the SDEX route. */
async function buildClassicSwap(
  sourceAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  expectedOut: bigint,
  slippageBps: number,
  partnerPayment?: { destination: string; amount: bigint }
): Promise<string> {
  const sendAsset = classicAssetFor(tokenIn);
  const destAsset = classicAssetFor(tokenOut);

  // Fetch the winning path's hops from Horizon
  const params = new URLSearchParams({
    source_amount: toDisplay7(amountIn),
    destination_assets: destAsset.isNative()
      ? 'native'
      : `${destAsset.getCode()}:${destAsset.getIssuer()}`,
  });
  if (sendAsset.isNative()) {
    params.set('source_asset_type', 'native');
  } else {
    params.set('source_asset_type', sendAsset.getCode().length <= 4 ? 'credit_alphanum4' : 'credit_alphanum12');
    params.set('source_asset_code', sendAsset.getCode());
    params.set('source_asset_issuer', sendAsset.getIssuer());
  }
  const res = await fetch(`${config.horizonUrl}/paths/strict-send?${params}`);
  if (!res.ok) throw new Error(`Horizon path lookup failed: ${res.status}`);
  const data = (await res.json()) as any;
  const best = (data?._embedded?.records || [])[0];
  if (!best) throw new BadRequest('No classic path available for this pair');

  const path: InstanceType<typeof Asset>[] = (best.path || []).map((p: any) =>
    p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
  );
  const destMin = (expectedOut * BigInt(10000 - slippageBps)) / 10000n;

  return stellar.buildClassicPathPayment({
    sourceAddress,
    sendAsset,
    sendAmount: toDisplay7(amountIn),
    destAsset,
    destMin: toDisplay7(destMin > 0n ? destMin : 1n),
    path,
    partnerPayment:
      partnerPayment && partnerPayment.amount > 0n
        ? { destination: partnerPayment.destination, amount: toDisplay7(partnerPayment.amount) }
        : undefined,
  });
}

/**
 * Best-execution comparison shared by /api/swap/build and the v1
 * integrator API: Soroban route (Router-executable venues) vs the classic
 * SDEX path. Classic ops can't be Router segments (Soroban contracts
 * cannot submit classic operations), so when SDEX wins the user signs a
 * classic path-payment-strict-send directly.
 *
 * BLENDED execution: when the optimal allocation mixes SDEX and AMM
 * liquidity (thin book with a tight inside quote), the single-tx
 * either/or leaves money on the table. The allocator runs once more with
 * the SDEX included as a venue; if the mixed allocation beats the best
 * single route by more than the gate (both a bps floor and an absolute
 * floor — so dust swaps and fee-eating gains never trigger it), we return
 * a two-transaction plan. Both legs carry their own min-out, so the
 * failure mode of losing atomicity is "one leg didn't execute," never a
 * worse price. The user experience is one extra wallet approval, shown
 * only when it pays for itself.
 */
const BLEND_MIN_GAIN_BPS = BigInt(process.env.BLEND_MIN_GAIN_BPS || '10');
const BLEND_MIN_GAIN_UNITS = BigInt(process.env.BLEND_MIN_GAIN_UNITS || '1000000'); // 0.1 token-out

interface BlendPlan {
  sdexIn: bigint;
  sdexOut: bigint;
  ammIn: bigint;
  /** AMM leg output net of the Router's 0.5 bps protocol fee */
  ammNet: bigint;
  blendNet: bigint;
  gain: bigint;
  mixed: Awaited<ReturnType<typeof routingEngine.computeRoute>>;
}

async function computeBestExecution(
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  slippage: number
): Promise<{
  /** Best plan including the blend (only /api/swap/build handles 'blend') */
  kind: 'classic' | 'soroban' | 'blend';
  /** Best single-transaction plan — what the v1 integrator API uses */
  singleKind: 'classic' | 'soroban';
  route: Awaited<ReturnType<typeof routingEngine.computeRoute>> | null;
  sdexOut: bigint;
  blend: BlendPlan | null;
}> {
  const sdexAdapter = registry.get(3);
  const [route, sdexOut, mixed] = await Promise.all([
    routingEngine
      .computeRoute(tokenIn, tokenOut, amountIn, slippage, { executableOnly: true })
      .catch(() => null),
    (async () => {
      if (!sdexAdapter || !(await sdexAdapter.isAvailable())) return 0n;
      try {
        return (await sdexAdapter.getQuote(tokenIn, tokenOut, amountIn)).amountOut;
      } catch {
        return 0n;
      }
    })(),
    routingEngine
      .computeRoute(tokenIn, tokenOut, amountIn, slippage, {
        executableOnly: true,
        includeClassicDex: true,
      })
      .catch(() => null),
  ]);

  const routeNet = route && route.instructions.length > 0 ? route.netAmountOut : 0n;
  const singleKind: 'classic' | 'soroban' = sdexOut > routeNet ? 'classic' : 'soroban';
  const singleBest = sdexOut > routeNet ? sdexOut : routeNet;

  let blend: BlendPlan | null = null;
  if (mixed) {
    const sdexSegs = mixed.segments.filter((s) => s.venueId === 3);
    const ammSegs = mixed.segments.filter((s) => s.venueId !== 3);
    if (sdexSegs.length > 0 && ammSegs.length > 0 && singleBest > 0n) {
      const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
      const sdexIn = sum(sdexSegs.map((s) => s.amountIn));
      const sdexMixOut = sum(sdexSegs.map((s) => s.expectedAmountOut));
      const ammIn = sum(ammSegs.map((s) => s.amountIn));
      const ammOut = sum(ammSegs.map((s) => s.expectedAmountOut));
      // Router charges 0.5 bps on the AMM leg's output; the classic leg
      // pays no protocol fee (the engine's own fee model charges the
      // total, which over-counts the SDEX portion — recompute here).
      const ammFee = ammOut > 0n ? (ammOut * 5n + 100_000n - 1n) / 100_000n : 0n;
      const ammNet = ammOut - ammFee;
      const blendNet = sdexMixOut + ammNet;
      const gain = blendNet - singleBest;
      if (gain >= BLEND_MIN_GAIN_UNITS && gain * 10_000n >= singleBest * BLEND_MIN_GAIN_BPS) {
        blend = { sdexIn, sdexOut: sdexMixOut, ammIn, ammNet, blendNet, gain, mixed };
      }
    }
  }

  return { kind: blend ? 'blend' : singleKind, singleKind, route, sdexOut, blend };
}

// ─── API Routes ─────────────────────────────────────────

/**
 * GET /api/assets
 *
 * The aggregated token universe: the curated registry (verified) plus
 * every token discovered from venue liquidity (currently Aqua pools).
 * Discovered tokens are tradeable via instant swap only — P2P stays on
 * the curated corridor.
 */
app.get('/api/assets', (_req, res) => {
  // TWAP eligibility: only tokens with a REGISTERED venue pool — the
  // adapters' pair registries (env mirrors of on-chain set_pool/set_pair)
  // are the source of truth. Self-maintaining: register a pool, the token
  // becomes TWAP-able.
  const eligibleSacs = new Set<string>();
  for (const envName of ['SUSHI_PAIRS', 'AQUA_PAIRS']) {
    try {
      const pairs = JSON.parse(process.env[envName] ?? '[]');
      for (const p of pairs) {
        if (p.tokenA) eligibleSacs.add(p.tokenA);
        if (p.tokenB) eligibleSacs.add(p.tokenB);
      }
    } catch {}
  }
  // With the v1.1 contracts (Sushi adapter resolves pools via the factory,
  // no per-pair registration), every discovered Sushi pair is TWAP-able.
  // Against v1.0 only registered pairs can execute slices, so gate on the
  // same flag that switches the rest of the backend to v1.1.
  if (config.swapbookV11) {
    for (const p of tokenDiscovery.getSushiPairs()) {
      eligibleSacs.add(p.tokenA);
      eligibleSacs.add(p.tokenB);
    }
  }
  res.json({
    assets: tokenDiscovery.getTokens().map((t) => {
      // SEP-1 handshake result: a discovered token whose issuer's own
      // domain vouches for it earns the verified badge automatically
      const earned =
        !t.homeDomain && t.issuer ? sep1.getDomain(t.symbol, t.issuer) : null;
      return {
        ...t,
        ...(earned ? { homeDomain: earned, verified: true } : {}),
        twapEligible: eligibleSacs.has(t.sacAddress),
      };
    }),
    discovery: tokenDiscovery.getStatus(),
    p2pAllowed: P2P_ALLOWED_TOKENS,
  });
});

/**
 * GET /api/quote
 *
 * Query params:
 *   tokenIn   - SAC address or asset symbol
 *   tokenOut  - SAC address or asset symbol
 *   amountIn  - Amount in base units (7 decimals)
 *   slippage  - Max slippage in bps (default: 50)
 */
app.get('/api/quote', async (req, res) => {
  try {
    const tokenIn = resolveTokenParam(req.query.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.query.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.query.amountIn, 'amountIn');
    const slippage = parseSlippageBps(req.query.slippage);

    // fast=1: stage-1 answer for the UI — direct route only, returns in
    // one engine pass while the full best-route search runs in a second
    // request. The pathfinder's result cache makes the follow-up cheap.
    const fastOnly = req.query.fast === '1';

    // Best execution: the direct route COMPETES with multi-hop paths
    // (up to 5 swaps across pools); highest net output wins.
    const { direct, multi } = fastOnly
      ? {
          direct: await routingEngine.computeRoute(tokenIn, tokenOut, amountIn, slippage, { executableOnly: true }, {
            in: decimalsForSac(tokenIn),
            out: decimalsForSac(tokenOut),
          }),
          multi: null,
        }
      : await pathfinder.bestRoute(tokenIn, tokenOut, amountIn, slippage);
    const directOut = direct.segments.length > 0 ? direct.netAmountOut : 0n;
    const multiOut = multi?.netAmountOut ?? 0n;

    if (directOut <= 0n && multiOut <= 0n) {
      res.status(404).json({
        error: 'No route: no direct market and no multi-hop path with liquidity (up to 5 swaps searched)',
        noLiquidity: true,
      });
      return;
    }

    // Honest cost figure: net output vs ORACLE fair value (RedStone /
    // Reflector). Raw unit-count bps mislead on non-pegged pairs and
    // price impact excludes venue fees — this is what the trade actually
    // cost. null (field omitted) when a token has no feed.
    const vsOracleBps = await fairValue
      .vsOracleBps({
        tokenInSac: tokenIn,
        tokenOutSac: tokenOut,
        symbolIn: symbolForSac(tokenIn),
        symbolOut: symbolForSac(tokenOut),
        amountIn,
        netAmountOut: multi && multiOut > directOut ? multiOut : directOut,
        decimalsIn: decimalsForSac(tokenIn),
        decimalsOut: decimalsForSac(tokenOut),
      })
      .catch(() => null);

    if (multi && multiOut > directOut) {
      const label = pathLabel(multi.path);
      res.json({
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        vsOracleBps,
        expectedOut: multiOut.toString(),
        netAmountOut: multiOut.toString(),
        protocolFee: '0',
        swapBookAmountOut: '0',
        blendedBps: 0,
        priceImpactBps: multi.hops.reduce(
          (s, h) => s + Math.max(0, h.route.priceImpactBps ?? 0), 0),
        multiHop: {
          path: multi.path,
          label,
          hopCount: multi.hops.length,
          note: `Best rate routes ${label} (${multi.hops.length} transactions to sign; any surplus intermediate tokens stay in your wallet)`,
          // Per-hop venue splits — everything the route diagram needs,
          // all already computed (zero extra latency)
          hops: multi.hops.map((h) => ({
            fromSymbol: symbolForSac(h.tokenIn) || h.tokenIn.slice(0, 4),
            toSymbol: symbolForSac(h.tokenOut) || h.tokenOut.slice(0, 4),
            venues: h.route.segments.map((s) => ({
              venue: s.venueName,
              pct:
                h.amountIn > 0n
                  ? Number((s.amountIn * 100n) / h.amountIn)
                  : 100,
            })),
          })),
        },
        segments: [
          {
            venue: `multi-hop: ${label}`,
            venueId: multi.hops[0].route.segments[0]?.venueId ?? 1,
            amountIn: amountIn.toString(),
            expectedOut: multiOut.toString(),
            effectiveBps: 0,
          },
        ],
        instructions: [],
      });
      return;
    }
    const route = direct;

    res.json({
      tokenIn: route.tokenIn,
      tokenOut: route.tokenOut,
      amountIn: route.totalAmountIn.toString(),
      vsOracleBps,
      expectedOut: route.totalExpectedOut.toString(),
      netAmountOut: route.netAmountOut.toString(),
      protocolFee: route.protocolFee.toString(),
      swapBookAmountOut: route.swapBookAmountOut.toString(),
      blendedBps: route.blendedBps,
      priceImpactBps: route.priceImpactBps,
      segments: route.segments
        .filter((s) => s.amountIn > 0n)
        .map((s) => ({
          venue: s.venueName,
          venueId: s.venueId,
          amountIn: s.amountIn.toString(),
          expectedOut: s.expectedAmountOut.toString(),
          effectiveBps: s.effectiveBps,
        })),
      instructions: route.instructions.map((i) => ({
        venueContractId: i.venueContractId,
        venueId: i.venueId,
        amountIn: i.amountIn.toString(),
        minAmountOut: i.minAmountOut.toString(),
      })),
    });
  } catch (error) {
    handleError(res, error, 'Failed to compute route');
  }
});

/**
 * GET /api/orders
 */
app.get('/api/orders', async (req, res) => {
  try {
    const tokenIn = resolveTokenParam(req.query.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.query.tokenOut, 'tokenOut');

    const orders = await fetchOrdersForPair(tokenIn, tokenOut);
    res.json({ orders: orders.filter(isOpen).map((o) => orderToJson(o)) });
  } catch (error) {
    handleError(res, error, 'Failed to fetch orders');
  }
});

/**
 * GET /api/orders/user/:address
 *
 * Fetch all open orders placed by a specific wallet address.
 * Scans all live token pairs since on-chain storage is pair-indexed.
 */
app.get('/api/orders/user/:address', async (req, res) => {
  try {
    const userAddress = parseStellarAccount(req.params.address, 'address');
    const liveTokens = Object.values(TOKENS).filter(
      (t) => t.status === 'live' && t.sacAddress
    );

    const pairs: Array<{ in: (typeof liveTokens)[number]; out: (typeof liveTokens)[number] }> = [];
    for (const a of liveTokens) {
      for (const b of liveTokens) {
        if (a.symbol !== b.symbol) pairs.push({ in: a, out: b });
      }
    }

    const allOrders: any[] = [];
    await Promise.all(
      pairs.map(async (pair) => {
        try {
          const orders = await fetchOrdersForPair(pair.in.sacAddress, pair.out.sacAddress);
          for (const order of orders) {
            if (order.maker === userAddress && isOpen(order)) {
              allOrders.push(
                orderToJson(order, {
                  tokenInSymbol: pair.in.symbol,
                  tokenOutSymbol: pair.out.symbol,
                })
              );
            }
          }
        } catch {
          // Skip pairs that fail
        }
      })
    );

    res.json({ orders: allOrders });
  } catch (error) {
    handleError(res, error, 'Failed to fetch user orders');
  }
});

/**
 * POST /api/orders/cancel
 *
 * Build an unsigned cancel_order transaction. The maker's wallet signature
 * is what authorizes the cancel on-chain (order.maker.require_auth).
 *
 * Body:
 *   sourceAddress - User's Stellar address (must be the maker)
 *   orderId       - The order ID to cancel
 */
app.post('/api/orders/cancel', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const orderId = Number(req.body.orderId);
    if (!Number.isInteger(orderId) || orderId < 1) {
      throw new BadRequest('orderId must be a positive integer');
    }

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.swapbookContractId,
      'cancel_order',
      [StellarClient.toU64(orderId)]
    );

    res.json({ xdr });
  } catch (error) {
    handleError(res, error, 'Failed to build cancel transaction');
  }
});

/**
 * POST /api/swap/build
 * Build an unsigned Router.execute_route transaction for an instant swap.
 *
 * Only Router-executable venues (DEX adapters) are used for the on-chain
 * route. P2P book liquidity is accessed via /api/peer-swap/build instead.
 *
 * Body:
 *   sourceAddress - User's Stellar address
 *   tokenIn, tokenOut - SAC addresses or symbols
 *   amountIn - Base units
 *   slippage - bps (default 50)
 */
app.post('/api/swap/build', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    await assertNotBlocked(sourceAddress);
    const tokenIn = resolveTokenParam(req.body.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.body.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.body.amountIn, 'amountIn');
    const slippage = parseSlippageBps(req.body.slippage);

    const { kind, singleKind, route, sdexOut, blend } = await computeBestExecution(tokenIn, tokenOut, amountIn, slippage);

    // Blended execution: SDEX chunk as a classic tx + AMM chunk through the
    // Router — two signatures, each leg min-out protected. Only returned
    // when the gain clears the gate (see computeBestExecution).
    if (kind === 'blend' && blend) {
      const classicXdr = await buildClassicSwap(
        sourceAddress, tokenIn, tokenOut, blend.sdexIn, blend.sdexOut, slippage
      );
      const ammMinOut = (blend.ammNet * BigInt(10000 - slippage)) / 10000n;
      const ammInstructions = blend.mixed.instructions.filter((i) => i.venueId !== 3);
      const sorobanXdr = await stellar.buildTransaction(
        sourceAddress,
        config.routerContractId,
        'execute_route',
        [
          StellarClient.toAddress(sourceAddress),
          StellarClient.toAddress(tokenIn),
          StellarClient.toAddress(tokenOut),
          StellarClient.toI128(blend.ammIn),
          StellarClient.toI128(ammMinOut > 0n ? ammMinOut : 1n),
          StellarClient.toRouteSegments(
            ammInstructions.map((i) => ({
              venueId: i.venueId,
              amountIn: i.amountIn,
              minAmountOut: i.minAmountOut,
            }))
          ),
        ]
      );
      res.json({
        kind: 'blend',
        legs: [
          { kind: 'classic', xdr: classicXdr, amountIn: blend.sdexIn.toString(), expectedOut: blend.sdexOut.toString() },
          { kind: 'soroban', xdr: sorobanXdr, amountIn: blend.ammIn.toString(), expectedOut: blend.ammNet.toString() },
        ],
        route: {
          totalAmountIn: amountIn.toString(),
          netAmountOut: blend.blendNet.toString(),
          minTotalOut: ((blend.blendNet * BigInt(10000 - slippage)) / 10000n).toString(),
          blendedBps: Number(((amountIn - blend.blendNet) * 10000n) / amountIn),
          blendGain: blend.gain.toString(),
          segments: blend.mixed.segments
            .filter((s) => s.amountIn > 0n)
            .map((s) => ({
              venue: s.venueId === 3 ? 'StellarDEX (classic)' : s.venueName,
              venueId: s.venueId,
              amountIn: s.amountIn.toString(),
              expectedOut: s.expectedAmountOut.toString(),
            })),
        },
      });
      return;
    }

    if (singleKind === 'classic') {
      const xdr = await buildClassicSwap(sourceAddress, tokenIn, tokenOut, amountIn, sdexOut, slippage);
      res.json({
        xdr,
        kind: 'classic',
        route: {
          totalAmountIn: amountIn.toString(),
          netAmountOut: sdexOut.toString(),
          minTotalOut: ((sdexOut * BigInt(10000 - slippage)) / 10000n).toString(),
          blendedBps: Number(((amountIn - sdexOut) * 10000n) / amountIn),
          segments: [{ venue: 'StellarDEX (classic)', venueId: 3, amountIn: amountIn.toString(), expectedOut: sdexOut.toString() }],
        },
      });
      return;
    }

    // Multi-hop competes with (or substitutes for) the direct route.
    const directOut2 =
      route && route.instructions.length > 0 ? route.netAmountOut : 0n;
    const multiPlan = await pathfinder.bestRoute(tokenIn, tokenOut, amountIn, slippage);
    const multi = multiPlan.multi;
    if ((!route || route.instructions.length === 0 || (multi && multi.netAmountOut > directOut2)) ) {
      if (!multi) {
        throw new BadRequest('No executable venue liquidity for this pair (direct or multi-hop, up to 5 swaps searched)');
      }
      const buildLeg = (h: PathResult['hops'][number]) =>
        stellar.buildTransaction(sourceAddress, config.routerContractId, 'execute_route', [
          StellarClient.toAddress(sourceAddress),
          StellarClient.toAddress(h.tokenIn),
          StellarClient.toAddress(h.tokenOut),
          StellarClient.toI128(h.amountIn),
          StellarClient.toI128(h.minOut),
          StellarClient.toRouteSegments(
            h.route.instructions.map((i) => ({
              venueId: i.venueId,
              amountIn: i.amountIn,
              minAmountOut: i.minAmountOut,
            }))
          ),
        ]);
      const label = pathLabel(multi.path);
      const lastHop = multi.hops[multi.hops.length - 1];
      if (config.routerV12) {
        // v1.2: the WHOLE path in one atomic transaction — one signature,
        // all-or-nothing, real outputs flow hop to hop on-chain.
        const finalMin = (multi.netAmountOut * BigInt(10000 - slippage)) / 10000n;
        const pathXdr = await stellar.buildTransaction(
          sourceAddress,
          config.routerContractId,
          'execute_path',
          [
            StellarClient.toAddress(sourceAddress),
            StellarClient.toAddress(tokenIn),
            StellarClient.toI128(amountIn),
            StellarClient.toI128(finalMin > 0n ? finalMin : 1n),
            StellarClient.toPathHops(
              multi.hops.map((h) => {
                const hopTotal = h.route.instructions.reduce(
                  (s, i) => s + i.amountIn,
                  0n
                );
                let assigned = 0;
                return {
                  tokenOut: h.tokenOut,
                  legs: h.route.instructions.map((i, idx) => {
                    // weights in bps of the hop input; last leg absorbs
                    // rounding so they always sum to exactly 10,000
                    const isLast = idx === h.route.instructions.length - 1;
                    const w = isLast
                      ? 10_000 - assigned
                      : Number((i.amountIn * 10_000n) / (hopTotal > 0n ? hopTotal : 1n));
                    assigned += w;
                    return { venueId: i.venueId, weightBps: w, minAmountOut: 0n };
                  }),
                };
              })
            ),
          ]
        );
        res.json({
          xdr: pathXdr,
          kind: 'soroban',
          multiHop: { path: multi.path, label, hops: multi.hops.length, atomic: true },
          route: {
            totalAmountIn: amountIn.toString(),
            netAmountOut: multi.netAmountOut.toString(),
            minTotalOut: finalMin.toString(),
            blendedBps: 0,
            segments: [
              {
                venue: `atomic path: ${label}`,
                venueId: multi.hops[0].route.segments[0]?.venueId ?? 1,
                amountIn: amountIn.toString(),
                expectedOut: multi.netAmountOut.toString(),
              },
            ],
          },
        });
        return;
      }
      // Only the FIRST hop can be built (simulated) now — later hops
      // spend tokens the wallet won't hold until the prior hop settles,
      // so their simulation fails on balance whenever the user doesn't
      // already carry the intermediate token. Later hops are returned as
      // deferred build params; the frontend re-requests each one after
      // the previous leg settles, sized to the prior hop's GUARANTEED
      // minimum output (any surplus stays in the wallet, as documented).

      // Protocol-skew guard: a stale frontend that predates deferred
      // legs would pass an empty XDR to the wallet (opaque wallet error,
      // AFTER leg 1 executed). Refuse with a clear message instead.
      if (multi.hops.length > 1 && req.body.supportsDeferred !== true) {
        throw new BadRequest(
          'This multi-hop swap needs the latest app — refresh the page and try again.'
        );
      }

      // Pre-flight every LATER hop before the user signs anything: leg
      // N+1 can't be balance-simulated until leg N settles, but venue
      // EXECUTABILITY is checkable now via the adapter's read-only
      // quote. Catches unregistered pools/pairs upfront so a plan never
      // knowingly strands the user mid-path on a dead leg. (Price-move
      // failures remain possible by design — min_out protects the user —
      // and only v1.2's atomic execute_path removes them entirely.)
      await Promise.all(
        multi.hops.slice(1).flatMap((h) =>
          h.route.instructions
            .filter((ins) => /^C[A-Z2-7]{55}$/.test(ins.venueContractId))
            .map(async (ins) => {
            const out = await stellar.simulateAndParse<bigint>(
              ins.venueContractId,
              'quote',
              [
                StellarClient.toAddress(h.tokenIn),
                StellarClient.toAddress(h.tokenOut),
                StellarClient.toI128(ins.amountIn),
              ]
            );
            if (out === null || out <= 0n) {
              const sym = (sac: string) => symbolForSac(sac) || `${sac.slice(0, 4)}…`;
              throw new BadRequest(
                `A later leg of this route (${sym(h.tokenIn)} → ${sym(h.tokenOut)}) is not executable on-chain right now — no funds were moved. Try again shortly.`
              );
            }
          })
        )
      );

      const firstXdr = await buildLeg(multi.hops[0]);
      res.json({
        kind: 'blend', // frontend signs legs sequentially, each min-out protected
        multiHop: { path: multi.path, label, hops: multi.hops.length },
        legs: multi.hops.map((h, i) => ({
          kind: 'soroban',
          ...(i === 0
            ? { xdr: firstXdr }
            : {
                deferred: {
                  tokenIn: h.tokenIn,
                  tokenOut: h.tokenOut,
                  // prior hop's min-out is the amount guaranteed to exist
                  amountIn: multi.hops[i - 1].minOut.toString(),
                },
              }),
          amountIn: h.amountIn.toString(),
          expectedOut: h.route.netAmountOut.toString(),
        })),
        route: {
          totalAmountIn: amountIn.toString(),
          netAmountOut: multi.netAmountOut.toString(),
          minTotalOut: lastHop.minOut.toString(),
          blendedBps: 0,
          segments: [
            {
              venue: `multi-hop: ${label}`,
              venueId: multi.hops[0].route.segments[0]?.venueId ?? 1,
              amountIn: amountIn.toString(),
              expectedOut: multi.netAmountOut.toString(),
            },
          ],
        },
      });
      return;
    }

    // min_total_out: expected net output with slippage tolerance applied
    const minTotalOut =
      (route.netAmountOut * BigInt(10000 - slippage)) / 10000n;
    if (minTotalOut <= 0n) {
      throw new BadRequest('Route output too small');
    }

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.routerContractId,
      'execute_route',
      [
        StellarClient.toAddress(sourceAddress),
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(route.totalAmountIn),
        StellarClient.toI128(minTotalOut),
        StellarClient.toRouteSegments(
          route.instructions.map((i) => ({
            venueId: i.venueId,
            amountIn: i.amountIn,
            minAmountOut: i.minAmountOut,
          }))
        ),
      ]
    );

    res.json({
      xdr,
      kind: 'soroban',
      route: {
        totalAmountIn: route.totalAmountIn.toString(),
        netAmountOut: route.netAmountOut.toString(),
        minTotalOut: minTotalOut.toString(),
        blendedBps: route.blendedBps,
        segments: route.segments.map((s) => ({
          venue: s.venueName,
          venueId: s.venueId,
          amountIn: s.amountIn.toString(),
          expectedOut: s.expectedAmountOut.toString(),
        })),
      },
    });
  } catch (error) {
    handleError(res, error, 'Failed to build transaction');
  }
});

/**
 * POST /api/peer-swap/build
 *
 * Build a Peer Swap plan. This:
 *   1. Checks for matching orders on the reverse side (tokenOut → tokenIn)
 *   2. If matches exist, builds fill transactions (partial or full)
 *   3. Any remaining amount gets placed as a new sitting order
 *
 * NOTE: these are returned as separate transactions the wallet signs in
 * sequence — the book can move between them. Collapsing them into one
 * multi-op transaction is tracked as follow-up work.
 *
 * Body:
 *   sourceAddress    - User's Stellar address
 *   tokenIn          - Token being sold (symbol or SAC address)
 *   tokenOut         - Token being bought (symbol or SAC address)
 *   amountIn         - Amount to sell (base units, 7 decimals)
 *   minAmountOut     - Minimum acceptable output (base units). Required for Fixed mode.
 *   expiry           - Ledger sequence at which unfilled remainder expires (optional)
 *   priceMode        - 0 = Fixed (default), 1 = Oracle (market price)
 *   maxSlippageBps   - Max slippage for Oracle mode (default: 50 = 0.50%)
 *   autoRouteMinutes - Minutes to sit on P2P book before auto-routing via DEXs.
 */
app.post('/api/peer-swap/build', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    await assertNotBlocked(sourceAddress);
    assertP2pAllowed(req.body.tokenIn, 'tokenIn');
    assertP2pAllowed(req.body.tokenOut, 'tokenOut');
    const tokenIn = resolveTokenParam(req.body.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.body.tokenOut, 'tokenOut');
    const amountInBig = parseAmount(req.body.amountIn, 'amountIn');
    const minOutBig = parseAmount(req.body.minAmountOut, 'minAmountOut');
    const priceModeVal = req.body.priceMode === 1 ? 1 : 0;
    const slippageBps = parseSlippageBps(req.body.maxSlippageBps);
    const autoRouteMinutes = Number(req.body.autoRouteMinutes ?? 0);
    if (!Number.isFinite(autoRouteMinutes) || autoRouteMinutes < 0) {
      throw new BadRequest('autoRouteMinutes must be a non-negative number');
    }

    // 1. Reverse-side sitting orders are our matches. Skip the taker's
    //    own orders and any order that excludes this taker (v1.1).
    const candidates = (await fetchOrdersForPair(tokenOut, tokenIn)).filter(
      (o) =>
        isOpen(o) &&
        o.priceMode === 'Fixed' &&
        o.amountIn > 0n &&
        o.maker !== sourceAddress &&
        !o.excluded.includes(sourceAddress)
    );
    // Organic liquidity first; protocol-operated (SDF) wallets are the
    // fallback — so growing organic volume naturally displaces them.
    const reverseOrders = [
      ...candidates.filter((o) => !SDF_LIQUIDITY_WALLETS.includes(o.maker)),
      ...candidates.filter((o) => SDF_LIQUIDITY_WALLETS.includes(o.maker)),
    ];

    // 2. Greedy fill planning (ceiling payments — mirrors contract rounding)
    let budget = amountInBig;
    const fills: Array<{
      orderId: number;
      fillAmountIn: bigint; // how much of the reverse order's token we take
      paymentOut: bigint;   // how much of our tokenIn we pay
      full: boolean;
    }> = [];

    for (const order of reverseOrders) {
      if (budget <= 0n) break;
      const remaining = order.amountInRemaining;
      if (remaining <= 0n) continue;

      // Full-fill cost for the remaining amount (ceil pro-rata)
      const fullCost = muldivCeil(order.minAmountOut, remaining, order.amountIn);

      if (budget >= fullCost) {
        fills.push({ orderId: order.id, fillAmountIn: remaining, paymentOut: fullCost, full: true });
        budget -= fullCost;
      } else {
        // Partial: how much can our budget buy at this order's rate?
        let fillable = (budget * order.amountIn) / order.minAmountOut;
        if (fillable > remaining) fillable = remaining;
        while (fillable > 0n) {
          const cost = muldivCeil(order.minAmountOut, fillable, order.amountIn);
          if (cost <= budget) {
            fills.push({ orderId: order.id, fillAmountIn: fillable, paymentOut: cost, full: false });
            budget -= cost;
            break;
          }
          fillable -= 1n;
        }
      }
    }

    const amountToSit = budget;
    const totalBought = fills.reduce((s, f) => s + f.fillAmountIn, 0n);
    const totalPaid = fills.reduce((s, f) => s + f.paymentOut, 0n);

    // 3. Shared placement parameters for any escrowed remainder
    const currentLedger = await stellar.getLatestLedger();
    const orderExpiry = Number.isInteger(req.body.expiry) && req.body.expiry > currentLedger
      ? Number(req.body.expiry)
      : currentLedger + DEFAULT_EXPIRY_LEDGERS;
    const autoRouteAfter =
      autoRouteMinutes > 0
        ? currentLedger + Math.ceil((autoRouteMinutes * 60) / LEDGER_SECONDS)
        : 0;
    // Pro-rata min for the sitting remainder (round up — protects the maker)
    const proRataMinOut =
      amountToSit > 0n ? muldivCeil(minOutBig, amountToSit, amountInBig) : 0n;

    // Excluded counterparties (v1.1 contracts only). Protocol-operated
    // liquidity wallets automatically exclude their siblings — the
    // inventory can never cross itself on-chain. Other makers may pass
    // their own list (≤ 5, the contract cap).
    let excluded: string[] = [];
    if (SDF_LIQUIDITY_WALLETS.includes(sourceAddress)) {
      excluded = SDF_LIQUIDITY_WALLETS.filter((w) => w !== sourceAddress);
    } else if (Array.isArray(req.body.excludedCounterparties)) {
      excluded = req.body.excludedCounterparties.map((a: unknown, i: number) =>
        parseStellarAccount(a, `excludedCounterparties[${i}]`)
      );
    }
    if (excluded.length > 5) {
      throw new BadRequest('excludedCounterparties: at most 5 addresses');
    }

    // 4. Build transactions
    const xdrs: string[] = [];
    if (config.swapbookV11) {
      // v1.1: ONE atomic invocation — fills settle and the remainder
      // escrows in the same transaction, so the book can't move mid-plan.
      xdrs.push(
        await stellar.buildTransaction(
          sourceAddress,
          config.swapbookContractId,
          'match_and_place',
          [
            StellarClient.toAddress(sourceAddress),
            StellarClient.toAddress(tokenIn),
            StellarClient.toAddress(tokenOut),
            StellarClient.toI128(amountInBig),
            StellarClient.toI128(priceModeVal === 1 ? 0n : proRataMinOut),
            StellarClient.toU32(orderExpiry),
            StellarClient.toU32(priceModeVal),
            StellarClient.toU32(priceModeVal === 1 ? slippageBps : 0),
            StellarClient.toU32(autoRouteAfter),
            StellarClient.toAddressVec(excluded),
            StellarClient.toFillSpecs(
              fills.map((f) => ({
                orderId: f.orderId,
                fillAmountIn: f.fillAmountIn,
                amountOut: f.paymentOut,
              }))
            ),
          ]
        )
      );
    } else {
      // v1.0 contracts: separate transactions per fill + placement
      for (const fill of fills) {
        const method = fill.full ? 'fill_order' : 'partial_fill';
        const args = fill.full
          ? [
              StellarClient.toAddress(sourceAddress),
              StellarClient.toU64(fill.orderId),
              StellarClient.toI128(fill.paymentOut),
            ]
          : [
              StellarClient.toAddress(sourceAddress),
              StellarClient.toU64(fill.orderId),
              StellarClient.toI128(fill.fillAmountIn),
              StellarClient.toI128(fill.paymentOut),
            ];
        try {
          xdrs.push(
            await stellar.buildTransaction(
              sourceAddress,
              config.swapbookContractId,
              method,
              args
            )
          );
        } catch (err) {
          console.warn(`Could not build fill tx for order ${fill.orderId}:`, err);
        }
      }

      if (amountToSit > 0n) {
        xdrs.push(
          await stellar.buildTransaction(
            sourceAddress,
            config.swapbookContractId,
            'place_order',
            [
              StellarClient.toAddress(sourceAddress),
              StellarClient.toAddress(tokenIn),
              StellarClient.toAddress(tokenOut),
              StellarClient.toI128(amountToSit),
              StellarClient.toI128(priceModeVal === 1 ? 0n : proRataMinOut),
              StellarClient.toU32(orderExpiry),
              StellarClient.toU32(priceModeVal),
              StellarClient.toU32(priceModeVal === 1 ? slippageBps : 0),
              StellarClient.toU32(autoRouteAfter),
            ]
          )
        );
      }
    }

    const remainderPlan: Record<string, unknown> | null =
      amountToSit > 0n
        ? {
            amountIn: amountToSit.toString(),
            minAmountOut: proRataMinOut.toString(),
            expiry: orderExpiry,
            autoRouteAfter,
            status: 'will_escrow',
          }
        : null;

    res.json({
      plan: {
        tokenIn,
        tokenOut,
        totalAmountIn: amountInBig.toString(),
        fills: fills.map((f) => ({
          orderId: f.orderId,
          youReceive: f.fillAmountIn.toString(),
          youPay: f.paymentOut.toString(),
          feesBps: 0.5,
        })),
        remainder: remainderPlan,
        summary: {
          instantFillAmount: totalBought.toString(),
          instantFillCost: totalPaid.toString(),
          escrowedAmount: amountToSit.toString(),
        },
      },
      xdrs, // Transactions to sign and submit in order
    });
  } catch (error) {
    handleError(res, error, 'Failed to build peer swap');
  }
});

// ─── TWAP endpoints ─────────────────────────────────────

/**
 * GET /api/twap/recommend?tokenIn&tokenOut&amountIn
 *
 * Suggests an execution window for a TWAP of this size. Two forces set
 * the slice count: each slice should carry enough notional that fixed
 * spreads/rounding don't dominate (~$25 floor), and each slice should
 * move the pool by only a few bps (impact / 10). Window = slices spaced
 * far enough apart that arbitrageurs can refill between them. An
 * ESTIMATE for convenience only — the response carries a disclaimer the
 * UI must show.
 */
app.get('/api/twap/recommend', async (req, res) => {
  try {
    const tokenIn = resolveTokenParam(req.query.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.query.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.query.amountIn, 'amountIn');
    const decIn = decimalsForSac(tokenIn);
    const units = Number(amountIn) / 10 ** decIn;
    const priceIn = await fairValue
      .priceUsd(tokenIn, symbolForSac(tokenIn))
      .catch(() => null);
    const notionalUsd = priceIn ? units * priceIn : null;

    // Full-size impact estimate (best-effort — recommendation still
    // works off notional alone when there's no direct route)
    let impactBps = 0;
    try {
      const route = await routingEngine.computeRoute(
        tokenIn,
        tokenOut,
        amountIn,
        50,
        { executableOnly: true },
        { in: decIn, out: decimalsForSac(tokenOut) }
      );
      impactBps = Math.max(0, route.priceImpactBps ?? 0);
    } catch {
      /* no direct route */
    }

    const MIN_SLICE_USD = 25;
    const REFILL_MINUTES = 2; // spacing that lets arbs re-center the pool
    const maxUsefulSlices = notionalUsd
      ? Math.max(1, Math.floor(notionalUsd / MIN_SLICE_USD))
      : 60;
    const slicesForImpact = Math.max(1, Math.ceil(impactBps / 10));
    const slices = Math.min(maxUsefulSlices, slicesForImpact);
    const recommendedMinutes =
      slices <= 1 ? 0 : Math.max(30, slices * REFILL_MINUTES);

    // Estimated receive: oracle fair output minus the TWAP protocol fee
    // (10 bps cap) and the expected per-slice venue cost. Network fees
    // for slice execution are paid by the protocol's keeper, NOT the
    // maker — so they don't reduce the estimate.
    const TWAP_FEE_BPS = 10;
    let estimatedOut: number | null = null;
    let sliceCostBps: number | null = null;
    const priceOut = await fairValue
      .priceUsd(tokenOut, symbolForSac(tokenOut))
      .catch(() => null);
    if (priceIn && priceOut && units > 0) {
      try {
        const sliceIn = amountIn / BigInt(Math.max(1, slices));
        if (sliceIn > 0n) {
          const sliceRoute = await routingEngine.computeRoute(
            tokenIn,
            tokenOut,
            sliceIn,
            50,
            { executableOnly: true },
            { in: decIn, out: decimalsForSac(tokenOut) }
          );
          sliceCostBps = await fairValue.vsOracleBps({
            tokenInSac: tokenIn,
            tokenOutSac: tokenOut,
            symbolIn: symbolForSac(tokenIn),
            symbolOut: symbolForSac(tokenOut),
            amountIn: sliceIn,
            netAmountOut: sliceRoute.netAmountOut,
            decimalsIn: decIn,
            decimalsOut: decimalsForSac(tokenOut),
          });
        }
      } catch {
        /* estimate degrades to impact-based below */
      }
      const fairOut = (units * priceIn) / priceOut;
      const costBps =
        (sliceCostBps ?? Math.max(impactBps, 5)) + TWAP_FEE_BPS;
      estimatedOut =
        Math.round(fairOut * (1 - Math.max(0, costBps) / 10000) * 1e7) / 1e7;
    }

    res.json({
      recommendedMinutes,
      slices,
      estimatedOut,
      sliceCostBps,
      twapFeeBps: TWAP_FEE_BPS,
      notionalUsd: notionalUsd ? Math.round(notionalUsd * 100) / 100 : null,
      impactBps: Math.round(impactBps * 10) / 10,
      note:
        slices <= 1
          ? 'This order is small enough that a single instant swap likely executes better than a TWAP — per-slice fees would dominate.'
          : `Sized so each of ~${slices} slices carries meaningful notional and moves the market only a few bps.`,
      disclaimer:
        'Estimate based on current pool depth and oracle prices; markets move and past depth is no guarantee. Not financial advice — you choose the window.',
    });
  } catch (error) {
    handleError(res, error, 'Failed to compute TWAP recommendation');
  }
});

/**
 * GET /api/twap/fee
 *
 * Current TWAP protocol fee, read from the TwapBook contract (get_fee).
 * The on-chain hard cap (10 bps) cannot be raised without deploying a new
 * contract, so the cap is reported as a constant.
 */
let twapFeeCache: { feeBps: number; ts: number } | null = null;
app.get('/api/twap/fee', async (_req, res) => {
  try {
    if (!config.twapBookContractId) throw new BadRequest('TWAP not deployed');
    if (!twapFeeCache || Date.now() - twapFeeCache.ts > 10 * 60_000) {
      const fee = await stellar.simulateAndParse<[bigint, bigint]>(
        config.twapBookContractId,
        'get_fee',
        []
      );
      if (!fee) throw new Error('get_fee simulation returned no result');
      twapFeeCache = { feeBps: Number(fee[0]) / (Number(fee[1]) / 10_000), ts: Date.now() };
    }
    res.json({ feeBps: twapFeeCache.feeBps, maxFeeBps: 10 });
  } catch (error) {
    handleError(res, error, 'Failed to read TWAP fee');
  }
});

/**
 * POST /api/twap/build
 *
 * Build an unsigned place_twap transaction (escrows the total on signing).
 *
 * Body:
 *   sourceAddress     - Maker's Stellar address
 *   tokenIn, tokenOut - Symbols or SAC addresses
 *   amountIn          - Total amount to execute (base units)
 *   durationMinutes   - Execution window (5 min .. 30 days)
 *   limitPrice        - Optional decimal price floor (min tokenOut per
 *                       tokenIn, e.g. "0.9995"). Omit for oracle-bound.
 *   maxSlippageBps    - Oracle mode slippage (default 50; ignored w/ limit)
 *   maxSlicePct       - Per-slice cap as % of total (default 10)
 *   minSliceGapSeconds- Min seconds between slices (default 60)
 *   paceToleranceBps  - Catch-up headroom in bps of total (default 500)
 */
app.post('/api/twap/build', async (req, res) => {
  try {
    if (!config.twapBookContractId) throw new BadRequest('TWAP not deployed');
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    await assertNotBlocked(sourceAddress);
    const tokenIn = resolveTokenParam(req.body.tokenIn, 'tokenIn');
    const tokenOut = resolveTokenParam(req.body.tokenOut, 'tokenOut');
    const amountIn = parseAmount(req.body.amountIn, 'amountIn');

    const durationMinutes = Number(req.body.durationMinutes);
    if (!Number.isFinite(durationMinutes) || durationMinutes < 5 || durationMinutes > 43_200) {
      throw new BadRequest('durationMinutes must be between 5 and 43200 (30 days)');
    }

    // Limit price: decimal → rational scaled to 1e7
    let limitNum = 0n;
    let limitDen = 0n;
    if (req.body.limitPrice !== undefined && req.body.limitPrice !== null && req.body.limitPrice !== '') {
      const price = Number(req.body.limitPrice);
      if (!Number.isFinite(price) || price <= 0) {
        throw new BadRequest('limitPrice must be a positive number');
      }
      limitNum = BigInt(Math.round(price * 1e7));
      limitDen = 10_000_000n;
    }
    const maxSlippageBps = limitNum > 0n ? 0 : parseSlippageBps(req.body.maxSlippageBps);

    const maxSlicePct = Number(req.body.maxSlicePct ?? 10);
    if (!Number.isFinite(maxSlicePct) || maxSlicePct < 1 || maxSlicePct > 100) {
      throw new BadRequest('maxSlicePct must be 1..100');
    }
    const maxSliceIn = (amountIn * BigInt(Math.round(maxSlicePct * 100)) + 9999n) / 10000n;

    const gapSeconds = Number(req.body.minSliceGapSeconds ?? 60);
    if (!Number.isFinite(gapSeconds) || gapSeconds < LEDGER_SECONDS || gapSeconds > 86_400) {
      throw new BadRequest('minSliceGapSeconds must be 5..86400');
    }
    const minSliceGap = Math.max(1, Math.round(gapSeconds / LEDGER_SECONDS));

    const paceToleranceBps = Number(req.body.paceToleranceBps ?? 500);
    if (!Number.isInteger(paceToleranceBps) || paceToleranceBps < 0 || paceToleranceBps > 5000) {
      throw new BadRequest('paceToleranceBps must be 0..5000');
    }

    const currentLedger = await stellar.getLatestLedger();
    const endLedger = currentLedger + Math.ceil((durationMinutes * 60) / LEDGER_SECONDS);

    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.twapBookContractId,
      'place_twap',
      [
        StellarClient.toAddress(sourceAddress),
        StellarClient.toAddress(tokenIn),
        StellarClient.toAddress(tokenOut),
        StellarClient.toI128(amountIn),
        StellarClient.toU32(endLedger),
        StellarClient.toI128(limitNum),
        StellarClient.toI128(limitDen),
        StellarClient.toU32(maxSlippageBps),
        StellarClient.toI128(maxSliceIn),
        StellarClient.toU32(minSliceGap),
        StellarClient.toU32(paceToleranceBps),
      ]
    );

    res.json({
      xdr,
      plan: {
        amountIn: amountIn.toString(),
        endLedger,
        durationMinutes,
        limitPrice: limitNum > 0n ? req.body.limitPrice : null,
        maxSlippageBps: limitNum > 0n ? null : maxSlippageBps,
        maxSliceIn: maxSliceIn.toString(),
        minSliceGapLedgers: minSliceGap,
        paceToleranceBps,
      },
    });
  } catch (error) {
    handleError(res, error, 'Failed to build TWAP order');
  }
});

/**
 * GET /api/twap/orders?maker=G...
 *
 * Active TWAP orders (optionally filtered by maker) with progress state.
 */
app.get('/api/twap/orders', async (req, res) => {
  try {
    if (!config.twapBookContractId) {
      res.json({ orders: [] });
      return;
    }
    const makerFilter = typeof req.query.maker === 'string' ? req.query.maker : null;

    const ids = await stellar.simulateAndParse<Array<number | bigint>>(
      config.twapBookContractId,
      'get_active_orders',
      []
    );
    if (!ids || ids.length === 0) {
      res.json({ orders: [] });
      return;
    }
    const currentLedger = await stellar.getLatestLedger();

    const orders = (
      await Promise.all(
        ids.map((id) =>
          stellar.simulateAndParse<any>(config.twapBookContractId, 'get_order', [
            StellarClient.toU64(BigInt(id)),
          ])
        )
      )
    )
      .filter(Boolean)
      .map((raw: any) => ({
        id: Number(raw.id),
        maker: String(raw.maker),
        tokenIn: String(raw.token_in),
        tokenOut: String(raw.token_out),
        totalIn: String(raw.total_in),
        filledIn: String(raw.filled_in),
        receivedOut: String(raw.received_out),
        startLedger: Number(raw.start_ledger),
        endLedger: Number(raw.end_ledger),
        limitNum: String(raw.limit_num),
        limitDen: String(raw.limit_den),
        maxSlippageBps: Number(raw.max_slippage_bps),
        lastSliceLedger: Number(raw.last_slice_ledger),
        status: scEnum(raw.status),
        // convenience for the UI — decimals/symbols so amounts render
        // correctly for non-7-decimal and high-unit-price tokens
        tokenInSymbol: symbolForSac(String(raw.token_in)),
        tokenOutSymbol: symbolForSac(String(raw.token_out)),
        tokenInDecimals: decimalsForSac(String(raw.token_in)),
        tokenOutDecimals: decimalsForSac(String(raw.token_out)),
        pctFilled: Number((BigInt(raw.filled_in) * 10000n) / BigInt(raw.total_in)) / 100,
        pctElapsed: Math.min(
          100,
          Math.max(
            0,
            ((currentLedger - Number(raw.start_ledger)) /
              (Number(raw.end_ledger) - Number(raw.start_ledger))) * 100
          )
        ),
        currentLedger,
      }))
      .filter((o) => !makerFilter || o.maker === makerFilter);

    res.json({ orders });
  } catch (error) {
    handleError(res, error, 'Failed to fetch TWAP orders');
  }
});

/**
 * POST /api/twap/cancel
 *
 * Build an unsigned cancel_twap transaction (maker signs; remainder refunds).
 */
app.post('/api/twap/cancel', async (req, res) => {
  try {
    if (!config.twapBookContractId) throw new BadRequest('TWAP not deployed');
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const orderId = Number(req.body.orderId);
    if (!Number.isInteger(orderId) || orderId < 1) {
      throw new BadRequest('orderId must be a positive integer');
    }
    const xdr = await stellar.buildTransaction(
      sourceAddress,
      config.twapBookContractId,
      'cancel_twap',
      [StellarClient.toU64(orderId)]
    );
    res.json({ xdr });
  } catch (error) {
    handleError(res, error, 'Failed to build cancel transaction');
  }
});

/**
 * POST /api/trustline/build
 *
 * Build an unsigned classic changeTrust transaction so a wallet can
 * receive a classic-backed token it has no trustline for. Restricted to
 * assets in the listed token universe so the endpoint can't be used to
 * push arbitrary trustlines at users.
 * Body: { sourceAddress, assetCode, issuer }
 */
app.post('/api/trustline/build', async (req, res) => {
  try {
    const sourceAddress = parseStellarAccount(req.body.sourceAddress, 'sourceAddress');
    const issuer = parseStellarAccount(req.body.issuer, 'issuer');
    const assetCode = String(req.body.assetCode ?? '');
    if (!/^[A-Za-z0-9]{1,12}$/.test(assetCode)) {
      throw new BadRequest('assetCode must be 1-12 alphanumeric characters');
    }
    const listed = tokenDiscovery
      .getTokens()
      .some((t) => t.symbol === assetCode && t.issuer === issuer);
    if (!listed) {
      throw new BadRequest('Asset is not in the listed token universe');
    }
    const xdr = await stellar.buildChangeTrust({
      sourceAddress,
      asset: new Asset(assetCode, issuer),
    });
    res.json({ xdr });
  } catch (error) {
    handleError(res, error, 'Failed to build trustline transaction');
  }
});

/**
 * POST /api/swap/submit
 *
 * Submit a signed transaction XDR to the Stellar network.
 */
app.post('/api/swap/submit', async (req, res) => {
  try {
    const { signedXdr } = req.body;
    if (typeof signedXdr !== 'string' || signedXdr.length === 0 || signedXdr.length > 100_000) {
      throw new BadRequest('signedXdr must be a transaction XDR string');
    }

    const result = await stellar.submitTransaction(signedXdr);
    // Hash lets the UI link the settled tx on an explorer. Computed from
    // the envelope so it works regardless of SDK response shape.
    const hash = TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase)
      .hash()
      .toString('hex');
    res.json({ status: result.status, hash, result });
  } catch (error) {
    // Submission failures carry user-actionable reasons (bad sequence,
    // failed on-ledger, try again) — pass them through instead of the
    // generic label so the UI can show what actually happened.
    if (
      error instanceof Error &&
      /rejected at send|failed on-ledger|not accepted|not confirmed/.test(error.message)
    ) {
      console.error('Submit failed:', error.message);
      res.status(502).json({ error: error.message });
      return;
    }
    handleError(res, error, 'Failed to submit transaction');
  }
});

/**
 * GET /api/oracle/price
 *
 * Get the latest oracle price for a pair (symbols like 'SolvBTC', 'USDC').
 */
app.get('/api/oracle/price', (req, res) => {
  const { tokenIn, tokenOut } = req.query;

  if (!tokenIn || !tokenOut) {
    res.status(400).json({ error: 'Missing required params: tokenIn, tokenOut' });
    return;
  }

  const price = oracleService.getPrice(tokenIn as string, tokenOut as string);

  if (!price) {
    res.json({
      available: false,
      tokenIn,
      tokenOut,
      message: 'No oracle price available for this pair',
    });
    return;
  }

  res.json({
    available: true,
    tokenIn,
    tokenOut,
    price: price.humanPrice,
    priceNum: price.priceNum.toString(),
    priceDen: price.priceDen.toString(),
    fetchedAt: price.fetchedAt.toISOString(),
  });
});

/**
 * GET /api/health
 */
/**
 * GET /api/balances/:address — balances for Soroban-native tokens in the
 * universe (no classic issuer → invisible to Horizon). Simulates
 * token.balance(address) per token; returns DISPLAY units as strings
 * (decimal-scaled server-side so the UI never touches raw 18-dec values).
 */
app.get('/api/balances/:address', async (req, res) => {
  try {
    const address = parseStellarAccount(req.params.address, 'address');
    const sorobanNative = tokenDiscovery
      .getTokens()
      .filter((t) => t.sacAddress && !t.issuer && t.symbol !== 'XLM');
    const balances = await Promise.all(
      sorobanNative.map(async (t) => {
        try {
          const raw = await stellar.simulateAndParse<bigint>(
            t.sacAddress,
            'balance',
            [StellarClient.toAddress(address)]
          );
          if (raw === null || raw === undefined) return null;
          const v = BigInt(raw);
          if (v === 0n) return null;
          const base = 10n ** BigInt(t.decimals);
          const whole = v / base;
          const frac = ((v % base) * 10_000_000n) / base; // 7 display digits
          return {
            symbol: t.symbol,
            balance: `${whole}.${frac.toString().padStart(7, '0')}`,
          };
        } catch {
          return null;
        }
      })
    );
    res.json({ balances: balances.filter(Boolean) });
  } catch (error) {
    handleError(res, error, 'Failed to fetch balances');
  }
});

/**
 * GET /api/screen/:address — connect-time compliance check for the UI.
 * Returns { allowed } so the frontend can refuse flagged wallets before
 * any quote is shown. Build endpoints enforce the same check server-side.
 */
app.get('/api/screen/:address', async (req, res) => {
  try {
    const address = parseStellarAccount(req.params.address, 'address');
    res.json({ allowed: !(await isBlocked(address)) });
  } catch (error) {
    handleError(res, error, 'Failed to screen address');
  }
});

const bootedAt = Date.now();
app.get('/api/health', async (_req, res) => {
  const venues = await registry.getAvailable();
  const disc = tokenDiscovery.getStatus();
  // Warm-up gate: until the first venue sweeps land, the path graph is
  // partial and multi-hop quotes answer "no route" for pairs that route
  // fine a minute later. Railway's healthcheck (railway.json) holds the
  // deploy cutover on a 503, so the OLD instance keeps serving until
  // this one actually knows the pools. Escape hatch after 4 minutes so
  // a venue-API outage can't block deploys forever — we go live
  // degraded rather than not at all.
  const discoveryReady =
    disc.lastRefresh !== null && disc.pools > 0 && disc.sushiPools > 0;
  const warmingUp = !discoveryReady && Date.now() - bootedAt < 240_000;
  res.status(warmingUp ? 503 : 200).json({
    status: warmingUp ? 'warming_up' : discoveryReady ? 'ok' : 'degraded',
    venues: venues.map((v) => ({ name: v.name, executable: v.executable })),
    discovery: disc,
    contracts: {
      swapbook: config.swapbookContractId,
      router: config.routerContractId,
      feeVault: config.feeVaultContractId,
    },
    network: config.rpcUrl,
  });
});

// ─── Integrator API v1 ──────────────────────────────────
//
// Public REST surface for wallet integrators (the Meru/AirTM/Beans
// pattern), mirroring the Soroswap API shape wallets already know:
// quote → build (unsigned XDR — the PARTNER'S USER signs, we never touch
// keys) → send. Keyed and rate-limited per partner.
//
// Keys: INTEGRATOR_API_KEYS env, comma-separated "name:key" pairs:
//   INTEGRATOR_API_KEYS=meru:ak_live_abc,airtm:ak_live_xyz
// Send the key as `x-api-key` or `Authorization: Bearer <key>`.
//
// Partner economics: feeBps (0..100 = up to 1%) + referralAddress. On
// classic (SDEX) routes the fee is a second payment op in the same tx —
// atomic with the swap, paid in tokenOut, requires the referral address
// to hold a trustline for it. Soroban-routed swaps return
// partnerFeeCollected:false until the Router contract grows a fee-split
// entry point (tracked follow-up); quotes still report which kind won so
// partners can decide.

const INTEGRATOR_KEYS = new Map<string, string>(); // api key -> partner name
for (const pair of (process.env.INTEGRATOR_API_KEYS ?? '').split(',')) {
  const idx = pair.indexOf(':');
  if (idx <= 0) continue;
  const name = pair.slice(0, idx).trim();
  const key = pair.slice(idx + 1).trim();
  if (name && key.length >= 16) INTEGRATOR_KEYS.set(key, name);
}
const V1_RATE_LIMIT_PER_MIN = parseInt(process.env.V1_RATE_LIMIT_PER_MIN || '120', 10);
const MAX_PARTNER_FEE_BPS = 100;
const v1Buckets = new Map<string, { count: number; windowStart: number }>();

function v1Auth(req: any, res: any, next: any): void {
  const header = req.headers['x-api-key'] ?? req.headers.authorization ?? '';
  const key = String(header).replace(/^Bearer\s+/i, '').trim();
  const partner = INTEGRATOR_KEYS.get(key);
  if (!partner) {
    res.status(401).json({ error: 'invalid or missing API key' });
    return;
  }
  const now = Date.now();
  let bucket = v1Buckets.get(key);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    bucket = { count: 0, windowStart: now };
    v1Buckets.set(key, bucket);
  }
  bucket.count += 1;
  if (bucket.count > V1_RATE_LIMIT_PER_MIN) {
    res.status(429).json({
      error: 'rate limit exceeded',
      limitPerMinute: V1_RATE_LIMIT_PER_MIN,
      retryAfterSeconds: Math.ceil((bucket.windowStart + 60_000 - now) / 1000),
    });
    return;
  }
  req.partner = partner;
  next();
}

function parsePartnerFee(body: any): { feeBps: number; referralAddress: string | null } {
  const feeBps = body.feeBps === undefined ? 0 : Number(body.feeBps);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_PARTNER_FEE_BPS) {
    throw new BadRequest(`feeBps must be an integer 0..${MAX_PARTNER_FEE_BPS}`);
  }
  let referralAddress: string | null = null;
  if (feeBps > 0) {
    referralAddress = parseStellarAccount(body.referralAddress, 'referralAddress');
  }
  return { feeBps, referralAddress };
}

/** GET /v1/health — auth check + which partner the key belongs to. */
app.get('/v1/health', v1Auth, (req: any, res) => {
  res.json({ status: 'ok', partner: req.partner, network: config.rpcUrl });
});

/** GET /v1/tokens — tradeable token universe with venue-volume ranking. */
app.get('/v1/tokens', v1Auth, (_req, res) => {
  res.json({
    tokens: tokenDiscovery.getTokens().map((t: any) => ({
      symbol: t.symbol,
      name: t.name,
      contract: t.sacAddress,
      issuer: t.issuer ?? null,
      decimals: 7,
      verified: t.verified ?? false,
      venueVolume: t.venueVolume ?? 0,
    })),
  });
});

/**
 * POST /v1/quote
 * Body: assetIn, assetOut (symbol or SAC contract), amount (base units,
 * string), slippageBps? (default 50), feeBps? (partner fee, 0..100).
 * EXACT_IN only. Quotes are indicative; /v1/quote/build re-prices.
 */
app.post('/v1/quote', v1Auth, async (req, res) => {
  try {
    const assetIn = resolveTokenParam(req.body.assetIn, 'assetIn');
    const assetOut = resolveTokenParam(req.body.assetOut, 'assetOut');
    const amount = parseAmount(req.body.amount, 'amount');
    const slippage = parseSlippageBps(req.body.slippageBps);
    const { feeBps, referralAddress } = parsePartnerFee(req.body);

    const { singleKind: kind, route, sdexOut } = await computeBestExecution(assetIn, assetOut, amount, slippage);
    const grossOut = kind === 'classic' ? sdexOut : route?.netAmountOut ?? 0n;
    if (grossOut <= 0n) throw new BadRequest('No liquidity for this pair');

    const partnerFee = (grossOut * BigInt(feeBps)) / 10000n;
    const netOut = grossOut - partnerFee;
    res.json({
      assetIn,
      assetOut,
      amountIn: amount.toString(),
      amountOut: netOut.toString(),
      partnerFee: partnerFee.toString(),
      partnerFeeCollected:
        kind === 'classic' ||
        feeBps === 0 ||
        (config.swapbookV11 && referralAddress !== null),
      minAmountOut: ((netOut * BigInt(10000 - slippage)) / 10000n).toString(),
      kind,
      segments:
        kind === 'classic'
          ? [{ venue: 'StellarDEX (classic)', amountIn: amount.toString(), expectedOut: sdexOut.toString() }]
          : route!.segments.map((s) => ({
              venue: s.venueName,
              amountIn: s.amountIn.toString(),
              expectedOut: s.expectedAmountOut.toString(),
            })),
    });
  } catch (error) {
    handleError(res, error, 'Failed to quote');
  }
});

/**
 * POST /v1/quote/build
 * Body: everything /v1/quote takes, plus `from` (the user's address that
 * will sign) and `referralAddress` (required when feeBps > 0; must hold a
 * trustline for assetOut). Returns { xdr, kind, partnerFeeCollected } —
 * hand the XDR to the user's wallet to sign, then POST /v1/send.
 */
app.post('/v1/quote/build', v1Auth, async (req, res) => {
  try {
    const from = parseStellarAccount(req.body.from, 'from');
    await assertNotBlocked(from);
    const assetIn = resolveTokenParam(req.body.assetIn, 'assetIn');
    const assetOut = resolveTokenParam(req.body.assetOut, 'assetOut');
    const amount = parseAmount(req.body.amount, 'amount');
    const slippage = parseSlippageBps(req.body.slippageBps);
    const { feeBps, referralAddress } = parsePartnerFee(req.body);

    const { singleKind: kind, route, sdexOut } = await computeBestExecution(assetIn, assetOut, amount, slippage);

    if (kind === 'classic') {
      const partnerFee = (sdexOut * BigInt(feeBps)) / 10000n;
      const xdr = await buildClassicSwap(
        from, assetIn, assetOut, amount, sdexOut, slippage,
        referralAddress && partnerFee > 0n
          ? { destination: referralAddress, amount: partnerFee }
          : undefined
      );
      res.json({
        xdr,
        kind,
        partnerFee: partnerFee.toString(),
        partnerFeeCollected: partnerFee > 0n,
        expectedOut: (sdexOut - partnerFee).toString(),
      });
      return;
    }

    if (!route || route.instructions.length === 0) {
      throw new BadRequest('No executable venue liquidity for this pair');
    }
    // v1.1 Router: partner fee carved on-chain via execute_route_partner
    // (additive — on top of the protocol fee, never out of it). Requires
    // SWAPBOOK_V11; against the v1.0 Router the fee is skipped as before.
    const usePartnerSplit =
      config.swapbookV11 && feeBps > 0 && referralAddress !== null;
    const partnerFeeEstimate = usePartnerSplit
      ? muldivCeil(route.netAmountOut, BigInt(feeBps * 10), 100_000n)
      : 0n;
    const netAfterPartner = route.netAmountOut - partnerFeeEstimate;
    const minTotalOut = (netAfterPartner * BigInt(10000 - slippage)) / 10000n;
    if (minTotalOut <= 0n) throw new BadRequest('Route output too small');
    const segArgs = StellarClient.toRouteSegments(
      route.instructions.map((i) => ({
        venueId: i.venueId,
        amountIn: i.amountIn,
        minAmountOut: i.minAmountOut,
      }))
    );
    const baseArgs = [
      StellarClient.toAddress(from),
      StellarClient.toAddress(assetIn),
      StellarClient.toAddress(assetOut),
      StellarClient.toI128(route.totalAmountIn),
      StellarClient.toI128(minTotalOut),
      segArgs,
    ];
    const xdr = usePartnerSplit
      ? await stellar.buildTransaction(from, config.routerContractId, 'execute_route_partner', [
          ...baseArgs,
          StellarClient.toAddress(referralAddress as string),
          // Contract takes per-100k (0.1 bp granularity): bps * 10
          StellarClient.toI128(BigInt(feeBps * 10)),
        ])
      : await stellar.buildTransaction(from, config.routerContractId, 'execute_route', baseArgs);
    res.json({
      xdr,
      kind,
      partnerFee: partnerFeeEstimate.toString(),
      partnerFeeCollected: usePartnerSplit,
      expectedOut: netAfterPartner.toString(),
    });
  } catch (error) {
    handleError(res, error, 'Failed to build transaction');
  }
});

/** POST /v1/send — submit a signed XDR. Body: { xdr }. */
app.post('/v1/send', v1Auth, async (req, res) => {
  try {
    const xdr = req.body.xdr;
    if (typeof xdr !== 'string' || xdr.length === 0 || xdr.length > 100_000) {
      throw new BadRequest('xdr must be a signed transaction XDR string');
    }
    const result = await stellar.submitTransaction(xdr);
    res.json({ status: result.status, result });
  } catch (error) {
    handleError(res, error, 'Failed to submit transaction');
  }
});

// ─── Start Server ───────────────────────────────────────

app.listen(config.port, () => {
  console.log(`Server running on http://localhost:${config.port}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  /api/health`);
  console.log(`  GET  /api/assets`);
  console.log(`  GET  /api/quote?tokenIn=...&tokenOut=...&amountIn=...`);
  console.log(`  GET  /api/orders?tokenIn=...&tokenOut=...`);
  console.log(`  POST /api/swap/build         — Build instant swap tx`);
  console.log(`  POST /api/peer-swap/build    — Build peer swap (auto-match + escrow remainder)`);
});

export default app;
