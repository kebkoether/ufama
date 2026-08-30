/**
 * Stellar token configuration and SAC (Stellar Asset Contract) helpers.
 *
 * All supported assets on Stellar use the SAC pattern — classic Stellar
 * assets automatically wrapped for Soroban smart contract use.
 *
 * To get a SAC address from a classic asset:
 *   stellar contract id asset --asset CODE:ISSUER --network mainnet
 */

export interface TokenConfig {
  symbol: string;
  name: string;
  /** Classic Stellar asset issuer address */
  issuer: string;
  /** Soroban SAC contract address (derived from issuer) */
  sacAddress: string;
  decimals: number;
  status: 'live' | 'coming_soon';
  /**
   * Issuer's verified home domain (the SEP-1 identity: the issuer
   * account's home_domain hosts a stellar.toml that declares this asset
   * back). Shown in the UI as the trust anchor — 'the USDC that
   * circle.com claims' — for curated tokens.
   */
  homeDomain?: string;
}

/**
 * Supported token configurations.
 *
 * SAC addresses are derived using:
 *   stellar contract id asset --asset SYMBOL:ISSUER --network mainnet
 *
 * These need to be populated after running the above command for each asset.
 */
export const TOKENS: Record<string, TokenConfig> = {
  // Native lumens. The SAC address is a network-wide constant on mainnet.
  // XLM must be in this registry: the timer-sweep keeper only scans pairs
  // of registry tokens, and the only Router-executable venue pools today
  // are XLM/USDC — without this entry the sweep could never route any
  // expired order (found live 2026-08-19: a USDC→XLM timer order sat
  // unswept to expiry while the keeper scanned stable-stable pairs only).
  XLM: {
    symbol: 'XLM',
    name: 'Stellar Lumens',
    issuer: '', // native asset — no issuer
    sacAddress: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
    decimals: 7,
    status: 'live',
    homeDomain: 'stellar.org',
  },
  USDC: {
    symbol: 'USDC',
    name: 'USD Coin (Circle)',
    // Issuer's on-chain home_domain claim. NOTE: Circle no longer hosts
    // a stellar.toml (the historic one was centre.io, dissolved), so the
    // automated SEP-1 handshake fails for the most legitimate asset on
    // the network — this curated entry is a hand attestation instead.
    homeDomain: 'circle.com',
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    sacAddress: '', // Run: stellar contract id asset --asset USDC:GA5ZSE... --network mainnet
    decimals: 7,
    status: 'live',
  },
  PYUSD: {
    symbol: 'PYUSD',
    name: 'PayPal USD',
    homeDomain: 'paxos.com',
    issuer: 'GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5',
    sacAddress: '', // Run: stellar contract id asset --asset PYUSD:GDQE7I... --network mainnet
    decimals: 7,
    status: 'live',
  },
  USDY: {
    symbol: 'USDY',
    name: 'Ondo US Dollar Yield',
    homeDomain: 'ondo.finance',
    issuer: 'GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6',
    sacAddress: '',
    decimals: 7,
    status: 'live',
  },
  USDT0: {
    symbol: 'USDT0',
    name: 'USDT0 (Tether via LayerZero)',
    // LIVE 2026-08-30: Sushi USDT0/USDC@0.05% pool
    // CBVHBZSZOS6KRDJ4D44FU2YLIENOVSSLM3UGKW6XQMVIFUAMWIWCVH2U seeded
    // ~$10k at parity (verified on-chain). Issuer still has no
    // home_domain (no SEP-1 badge) and clawback stays enabled
    // (auth_revocable + auth_clawback_enabled) — standard for
    // LayerZero-bridged Tether, but worth knowing.
    issuer: 'GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q',
    sacAddress: 'CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF',
    decimals: 7,
    status: 'live',
  },
  // SolvBTC placeholder removed 2026-08-22: Solv assets ARE live on the
  // DEXes (xSolvBTC on Aqua, SOLVBTC on Sushi) and venue discovery lists
  // them directly — a curated 'coming_soon' entry with no SAC only
  // rendered a dead row AND spoof-blocked the real discovered token
  // (curated symbols suppress same-symbol discovered tokens by design).
};

// ── Environment overrides ────────────────────────────────────────────
// Lets a deployment (testnet especially) repoint registry entries at
// different assets without code edits:
//   TOKEN_<SYMBOL>_ISSUER, TOKEN_<SYMBOL>_SAC, TOKEN_<SYMBOL>_STATUS
// e.g. TOKEN_USDT0_SAC=C... TOKEN_USDT0_STATUS=live for the testnet
// corridor where USDT0 is a test asset issued by the deployer.
for (const t of Object.values(TOKENS)) {
  const key = t.symbol.toUpperCase();
  const issuer = process.env[`TOKEN_${key}_ISSUER`];
  const sac = process.env[`TOKEN_${key}_SAC`];
  const status = process.env[`TOKEN_${key}_STATUS`];
  if (issuer) t.issuer = issuer;
  if (sac) t.sacAddress = sac;
  if (status === 'live' || status === 'coming_soon') t.status = status;
}

/**
 * Get all live tokens.
 */
export function getLiveTokens(): TokenConfig[] {
  return Object.values(TOKENS).filter((t) => t.status === 'live');
}

/**
 * Get all supported token pairs.
 * Every live token can be swapped for every other live token.
 */
export function getTokenPairs(): Array<{ tokenIn: TokenConfig; tokenOut: TokenConfig }> {
  const live = getLiveTokens();
  const pairs: Array<{ tokenIn: TokenConfig; tokenOut: TokenConfig }> = [];

  for (const tokenIn of live) {
    for (const tokenOut of live) {
      if (tokenIn.symbol !== tokenOut.symbol) {
        pairs.push({ tokenIn, tokenOut });
      }
    }
  }

  return pairs;
}

/**
 * Resolve a symbol or SAC address to a TokenConfig.
 */
export function resolveToken(symbolOrAddress: string): TokenConfig | undefined {
  // Try by symbol (case-insensitive — keys like 'SolvBTC' are mixed case)
  const upper = symbolOrAddress.toUpperCase();
  const bySymbol = Object.values(TOKENS).find(
    (t) => t.symbol.toUpperCase() === upper
  );
  if (bySymbol) return bySymbol;

  // Try by SAC address
  return Object.values(TOKENS).find(
    (t) => t.sacAddress === symbolOrAddress
  );
}

/**
 * Resolve to a SAC contract address or throw. Every route/order endpoint
 * must call this — passing raw symbols into Address() throws deep in the SDK.
 */
export function resolveSacAddress(symbolOrAddress: string): string {
  // Already a contract address?
  if (/^C[A-Z2-7]{55}$/.test(symbolOrAddress)) return symbolOrAddress;
  const token = resolveToken(symbolOrAddress);
  if (!token?.sacAddress) {
    throw new Error(`Unknown token or missing SAC address: ${symbolOrAddress}`);
  }
  return token.sacAddress;
}

/**
 * Format a token amount for display.
 * Stellar uses 7 decimal places for all SAC tokens.
 */
export function formatAmount(amount: bigint, decimals: number = 7): string {
  const divisor = BigInt(10 ** decimals);
  const whole = amount / divisor;
  const frac = amount % divisor;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

/**
 * Parse a display amount to base units.
 */
export function parseAmount(display: string, decimals: number = 7): bigint {
  const [whole, frac = ''] = display.split('.');
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals);
  return BigInt(whole + fracPadded);
}
