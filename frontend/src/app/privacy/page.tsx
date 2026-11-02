import { ACK_STORAGE_KEY, LEGAL_CONTACT, OPERATOR_NAME, SITE, TERMS_VERSION } from '@/lib/legal';

export const metadata = { title: 'Ufama — Privacy Notice' };

/*
 * DRAFT for counsel review. Describes what the hosted interface and API
 * actually process today (2026-11): no accounts, no analytics, no
 * server-side database; wallet addresses and transaction data (public
 * on-chain anyway), request metadata in provider logs and in-memory
 * rate-limit and RFQ state, and two localStorage keys in the browser.
 * Update this page if any of that changes.
 */

const SECTIONS: { title: string; paras: string[]; list?: string[] }[] = [
  {
    title: '1. Scope',
    paras: [
      'This Privacy Notice explains what ' + OPERATOR_NAME + ' ("we") processes when you use the website at ' + SITE + ', its API, and the SDK (together, the "Interface"). It does not cover the Stellar network itself, your wallet software, token issuers, or other third-party services, each of which has its own policy.',
      'We have no user accounts, no sign-up, no email list, no advertising, and no analytics or tracking scripts on the site. We collect as little as the service needs to work.',
    ],
  },
  {
    title: '2. What we process',
    paras: ['When you use the Interface we process the following:'],
    list: [
      'Wallet addresses and transaction data. When you connect a wallet, request a quote, place an order, or respond to a request for quote, your public Stellar address and the details of the transaction (tokens, amounts, prices, signed transaction envelopes) pass through our servers so we can build, simulate and relay transactions. This data is also recorded permanently and publicly on the Stellar ledger by the network, not by us.',
      'Request metadata. Our hosting providers (Vercel for the website, Railway for the API) and our rate limiter see your IP address, user agent, request path and timestamp. We use these to serve the site, defend against abuse, and apply per-address rate limits. We do not build profiles from them.',
      'RFQ state. Open quote requests and quotes (requester address, maker address, amounts, expiry) are held in server memory for minutes while a request is open, then discarded. Settled quotes exist only on the ledger.',
      'API keys. Integrators and market makers who are issued an API key are identified by that key and the label we assign it. We keep the key hash and the contact we issued it to.',
      'Email. If you write to us, we keep the correspondence for as long as needed to handle it.',
    ],
  },
  {
    title: '3. What we store in your browser',
    paras: ['The site uses two localStorage entries and no cookies:'],
    list: [
      'atomicswap.wallet: which wallet you last connected and its address, so the session can be restored. Removed when you disconnect.',
      ACK_STORAGE_KEY + ': the revision of the Terms you accepted (currently ' + TERMS_VERSION + '), so the acknowledgment is not shown on every connection.',
    ],
  },
  {
    title: '4. Who else sees data',
    paras: ['To do what you ask, data goes to third parties we rely on:'],
    list: [
      'Stellar network infrastructure: RPC and Horizon providers (including QuickNode and the public Stellar endpoints) receive the transactions we simulate and submit for you, and the addresses we look up.',
      'Hosting: Vercel (website) and Railway (API) process requests and keep standard server logs under their own retention policies.',
      'Market makers: in RFQ mode your request, including your address and the amount, is streamed to connected makers so they can quote it.',
      'Token issuers and oracles: we read published prices and net asset values from oracles (Reflector, RedStone) and issuers (Etherfuse). Those reads do not include your data.',
      'We do not sell data, share it with advertisers, or share it with anyone else except as needed to comply with law or a lawful request, to enforce our Terms, or to investigate abuse.',
    ],
  },
  {
    title: '5. Retention',
    paras: [
      'Transaction data on the ledger is permanent and outside our control. Server memory state (rate limits, open RFQs) lives minutes. Hosting-provider logs are kept according to those providers’ defaults, typically days to weeks. Email and API-key records are kept while the relationship lasts and for a reasonable period after.',
    ],
  },
  {
    title: '6. Where data is processed',
    paras: [
      'Our hosting providers run in the United States. If you use the Interface from elsewhere, your data is transferred to and processed in the United States.',
    ],
  },
  {
    title: '7. Your rights',
    paras: [
      'Depending on where you live you may have rights to access, correct, delete or restrict the processing of personal data about you, or to object to it. Because we hold almost nothing beyond public blockchain data and transient logs, there is usually little to act on, but you can write to ' + LEGAL_CONTACT + ' and we will respond. We cannot alter or delete data recorded on the Stellar ledger.',
    ],
  },
  {
    title: '8. Children',
    paras: ['The Interface is not directed to anyone under 18, and we do not knowingly collect data from children.'],
  },
  {
    title: '9. Changes and contact',
    paras: [
      'We will update this Notice when our processing changes and bump the revision date. Questions: ' + LEGAL_CONTACT + '.',
    ],
  },
];

const wrap: React.CSSProperties = { maxWidth: '860px', margin: '0 auto', padding: '32px 24px 64px' };
const section: React.CSSProperties = {
  background: '#131722',
  border: '1px solid #252a3a',
  borderRadius: '14px',
  padding: '22px',
  marginBottom: '16px',
};
const h2: React.CSSProperties = { fontSize: '16px', fontWeight: 700, color: '#e1e4ea', marginBottom: '10px' };
const p: React.CSSProperties = { fontSize: '14px', color: '#8a8f9c', lineHeight: 1.65, marginBottom: '10px' };

export default function PrivacyPage() {
  return (
    <div style={wrap}>
      <h1 style={{ fontSize: '26px', fontWeight: 700, color: '#e1e4ea', marginBottom: '6px' }}>Privacy Notice</h1>
      <p style={{ ...p, marginBottom: '24px' }}>
        Revision {TERMS_VERSION}. Part of our <a href="/terms" style={{ color: '#818cf8' }}>Terms of Use</a>.
      </p>
      {SECTIONS.map((s) => (
        <div key={s.title} style={section}>
          <div style={h2}>{s.title}</div>
          {s.paras.map((t, i) => <p key={i} style={p}>{t}</p>)}
          {s.list && (
            <ul style={{ paddingLeft: '20px' }}>
              {s.list.map((t, i) => <li key={i} style={{ ...p, marginBottom: '6px' }}>{t}</li>)}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
