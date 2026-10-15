/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {},
  env: {
    // Vercel injects the commit at build time; footer shows it so
    // "which build am I looking at" is a glance, not an investigation.
    NEXT_PUBLIC_BUILD_SHA: (process.env.VERCEL_GIT_COMMIT_SHA || 'dev').slice(0, 7),
  },
  async headers() {
    return [
      {
        // Baseline hardening for a wallet dapp. frame-ancestors/X-Frame-
        // Options stop another site from framing ufama and overlaying
        // its own UI on the swap button (clickjacking). A script-src CSP
        // is deliberately NOT set: wallet extensions and the wallets-kit
        // modal inject scripts/styles at runtime, and a wrong allowlist
        // would break connect on the live site — add it with testing.
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        ],
      },
      {
        // SEP-1 requires the stellar.toml to be readable cross-origin so
        // wallets and ecosystem scanners (Freighter/Blockaid, stellar.expert)
        // can fetch it from any context.
        source: '/.well-known/stellar.toml',
        headers: [
          { key: 'Access-Control-Allow-Origin', value: '*' },
          { key: 'Content-Type', value: 'text/plain; charset=utf-8' },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
