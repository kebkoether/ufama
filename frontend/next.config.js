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
