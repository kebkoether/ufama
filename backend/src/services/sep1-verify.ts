/**
 * SEP-1 issuer-domain handshake — automated "is this the real one?"
 *
 * The Stellar-native trust anchor, verified both ways:
 *   1. The asset's ISSUER ACCOUNT declares a home_domain on-chain
 *      (read via Horizon — the issuer controls this).
 *   2. That domain's https://{domain}/.well-known/stellar.toml must
 *      declare the SAME asset back (code + issuer in a [[CURRENCIES]]
 *      block — the website owner controls this).
 * Both parties vouching for each other = the token the issuer's own
 * website claims. A scam token can fake a symbol, but not Circle's DNS.
 *
 * Curated tokens carry hand-set domains; this service earns the same
 * green badge for venue-DISCOVERED classic assets automatically.
 * Soroban-native tokens (no classic issuer — deJAAA etc.) have no SEP-1
 * identity to check; their anchor remains the contract address.
 *
 * Verdicts are cached 24h (positive AND negative — a scam issuer's
 * missing toml shouldn't be re-fetched per request). All fetches are
 * timeboxed, size-capped, and swept in the background off the request
 * path.
 */

const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_TOML_BYTES = 300_000;
const SWEEP_CONCURRENCY = 3;

interface Verdict {
  domain: string | null;
  ts: number;
}

export class Sep1Verifier {
  private cache = new Map<string, Verdict>();

  constructor(private horizonUrl: string) {}

  /** Cached-only lookup for the request path — never fetches. */
  getDomain(code: string, issuer: string): string | null {
    const v = this.cache.get(`${code}|${issuer}`);
    return v && Date.now() - v.ts < TTL_MS ? v.domain : null;
  }

  /** Verify one asset; caches the verdict either way. */
  async verify(code: string, issuer: string): Promise<string | null> {
    const key = `${code}|${issuer}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < TTL_MS) return hit.domain;

    let domain: string | null = null;
    try {
      domain = await this.handshake(code, issuer);
    } catch {
      domain = null;
    }
    this.cache.set(key, { domain, ts: Date.now() });
    return domain;
  }

  /** Background sweep over many tokens with bounded concurrency. */
  async sweep(tokens: Array<{ symbol: string; issuer: string }>): Promise<number> {
    let verified = 0;
    for (let i = 0; i < tokens.length; i += SWEEP_CONCURRENCY) {
      const batch = tokens.slice(i, i + SWEEP_CONCURRENCY);
      const results = await Promise.all(
        batch.map((t) => this.verify(t.symbol, t.issuer))
      );
      verified += results.filter(Boolean).length;
    }
    return verified;
  }

  // ── internals ───────────────────────────────────────

  private async handshake(code: string, issuer: string): Promise<string | null> {
    // 1. Issuer's on-chain home_domain claim
    const acct = await fetch(`${this.horizonUrl}/accounts/${issuer}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!acct.ok) return null;
    const data = (await acct.json()) as { home_domain?: string };
    const domain = (data.home_domain ?? '').trim().toLowerCase();
    // Sanity: plausible public hostname only (never fetch internal names)
    if (
      !domain ||
      !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain) ||
      !domain.includes('.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(domain) ||
      domain.endsWith('.local') ||
      domain.endsWith('.internal')
    ) {
      return null;
    }

    // 2. The domain's stellar.toml must declare the asset back
    const res = await fetch(`https://${domain}/.well-known/stellar.toml`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (text.length > MAX_TOML_BYTES) return null;

    // Minimal TOML scan: [[CURRENCIES]] blocks with matching code+issuer.
    // (No TOML dependency — we only need two string fields per block.)
    const blocks = text.split(/\[\[CURRENCIES\]\]/i).slice(1);
    for (const block of blocks) {
      // stop each block at the next table header
      const body = block.split(/\n\s*\[/)[0];
      const codeMatch = body.match(/^\s*code\s*=\s*"([^"]+)"/im)?.[1];
      const issuerMatch = body.match(/^\s*issuer\s*=\s*"([^"]+)"/im)?.[1];
      if (
        codeMatch &&
        issuerMatch &&
        codeMatch.toUpperCase() === code.toUpperCase() &&
        issuerMatch === issuer
      ) {
        return domain;
      }
    }
    return null;
  }
}
