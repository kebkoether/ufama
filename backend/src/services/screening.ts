/**
 * Wallet screening (sanctions / compliance) — OFF-CHAIN by design.
 *
 * The contracts stay permissionless; screening happens where the industry
 * does it: the backend refuses to QUOTE-BUILD (and to open/prepare RFQs)
 * for flagged wallets. Providers:
 *   SCREENING_PROVIDER=none       (default) no screening
 *   SCREENING_PROVIDER=denylist   static list in SCREENING_DENYLIST (comma-sep G...)
 *   SCREENING_PROVIDER=predicate  Predicate v2 attestation API, off-chain mode
 *       PREDICATE_API_KEY             x-api-key from app.predicate.io (invite-only)
 *       PREDICATE_VERIFICATION_HASH   the project's verification hash (policy id)
 *       PREDICATE_API_URL             default https://api.predicate.io/v2/attestation
 *
 * Predicate v2 (docs.predicate.io, read 2026-11-02): POST /v2/attestation
 * with header `x-api-key`, body { verification_hash, from, chain:"stellar" }
 * -> { is_compliant: boolean, reason?, attestation? }. Stellar is a
 * supported chain; the off-chain path needs no on-chain registry. The
 * policy (sanctions lists, risk thresholds, allow/deny lists) lives in
 * their dashboard. The optional `attestation` would only matter if a
 * contract enforced it (their Soroban registry
 * CBJY4OV3CETD4PLOPRHNNGHLORKSHBVFFNNOTYRSSVGJSN5J7DMCH2Q7) — not used here.
 *
 * Fail-open vs fail-closed when the provider errors:
 *   SCREENING_FAIL_CLOSED=1 -> provider outage blocks builds (strict)
 *   default                 -> outage logs a warning and allows (available)
 *
 * Results are cached for CACHE_TTL_MS per address to keep the hot path fast.
 */

export interface ScreeningConfig {
  provider: 'none' | 'denylist' | 'predicate';
  denylist: Set<string>;
  predicateUrl: string;
  predicateKey: string;
  predicateVerificationHash: string;
  failClosed: boolean;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ScreeningConfig {
  const provider = (env.SCREENING_PROVIDER ?? 'none').toLowerCase();
  return {
    provider: provider === 'denylist' || provider === 'predicate' ? provider : 'none',
    denylist: new Set(
      (env.SCREENING_DENYLIST ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    ),
    predicateUrl: env.PREDICATE_API_URL || 'https://api.predicate.io/v2/attestation',
    predicateKey: env.PREDICATE_API_KEY ?? '',
    predicateVerificationHash: env.PREDICATE_VERIFICATION_HASH ?? '',
    failClosed: ['1', 'true'].includes((env.SCREENING_FAIL_CLOSED ?? '').toLowerCase()),
  };
}

const CACHE_TTL_MS = 10 * 60 * 1000;

export class BlockedAddressError extends Error {
  status = 403;
  constructor(address: string) {
    super(`Address ${address.slice(0, 6)}… failed compliance screening`);
  }
}

export interface PredicateResult {
  is_compliant: boolean;
  reason?: string;
}

/** One Predicate off-chain check. Throws on transport/shape errors. */
export async function predicateCheck(
  address: string,
  cfg: ScreeningConfig,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<PredicateResult> {
  if (!cfg.predicateKey || !cfg.predicateVerificationHash) {
    throw new Error('predicate screening selected but PREDICATE_API_KEY/PREDICATE_VERIFICATION_HASH unset');
  }
  const res = await fetchImpl(cfg.predicateUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.predicateKey,
    },
    body: JSON.stringify({
      verification_hash: cfg.predicateVerificationHash,
      from: address,
      chain: 'stellar',
    }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`predicate API ${res.status}`);
  const body: any = await res.json();
  if (typeof body?.is_compliant !== 'boolean') throw new Error('predicate: unrecognized response shape');
  return { is_compliant: body.is_compliant, reason: typeof body.reason === 'string' ? body.reason : undefined };
}

export class Screener {
  private cache = new Map<string, { blocked: boolean; ts: number }>();
  constructor(
    private cfg: ScreeningConfig,
    private fetchImpl?: FetchLike,
    private now: () => number = Date.now
  ) {}

  /** True if the address is blocked. Never throws (applies fail-open/closed). */
  async isBlocked(address: string): Promise<boolean> {
    const { cfg } = this;
    if (cfg.provider === 'none') return false;
    if (cfg.provider === 'denylist') return cfg.denylist.has(address);

    const hit = this.cache.get(address);
    if (hit && this.now() - hit.ts < CACHE_TTL_MS) return hit.blocked;
    try {
      const r = await predicateCheck(address, cfg, this.fetchImpl);
      const blocked = !r.is_compliant;
      if (blocked) console.warn(`screening: ${address.slice(0, 6)}… blocked${r.reason ? ` (${r.reason})` : ''}`);
      this.cache.set(address, { blocked, ts: this.now() });
      return blocked;
    } catch (err) {
      console.warn(`screening: provider error for ${address.slice(0, 6)}…:`, err instanceof Error ? err.message : err);
      return cfg.failClosed;
    }
  }

  async assertNotBlocked(address: string): Promise<void> {
    if (await this.isBlocked(address)) throw new BlockedAddressError(address);
  }
}

const defaultScreener = new Screener(configFromEnv());

/** True if the address is blocked. Never throws (applies fail-open/closed). */
export function isBlocked(address: string): Promise<boolean> {
  return defaultScreener.isBlocked(address);
}

/** Throws BlockedAddressError (HTTP 403) if the address is blocked. */
export function assertNotBlocked(address: string): Promise<void> {
  return defaultScreener.assertNotBlocked(address);
}
