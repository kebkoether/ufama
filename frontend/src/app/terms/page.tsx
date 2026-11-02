import { GOVERNING_STATE, LEGAL_CONTACT, OPERATOR_NAME, REPO_URL, SITE, TERMS_VERSION } from '@/lib/legal';

export const metadata = { title: 'Ufama — Terms of Use' };

/*
 * DRAFT for counsel review. Plain-English terms for a non-custodial
 * DeFi interface operated from the United States. Items to settle
 * before relying on this: operating entity (OPERATOR_NAME), governing
 * state (GOVERNING_STATE), and whether the arbitration clause is wanted.
 */

type Block = string | { list: string[] } | { table: string[][] };
interface Section {
  title: string;
  blocks: Block[];
}

const SECTIONS: Section[] = [
  {
    title: '1. Who we are and what you are agreeing to',
    blocks: [
      'These Terms of Use ("Terms") are an agreement between you and ' + OPERATOR_NAME + ' ("we", "us"). They govern your use of the website at ' + SITE + ', its subdomains, the application programming interface (API) it publishes, and any software we provide to access them (together, the "Interface").',
      'By using the Interface, connecting a wallet, or calling the API, you accept these Terms and our Privacy Notice. If you do not agree, do not use the Interface. If you use the Interface on behalf of an organization, you represent that you have authority to bind it.',
      'We may change these Terms. The revision date at the top of this page is the version in force; material changes will ask you to re-accept the next time you connect a wallet. Continued use after a change means you accept the new Terms.',
    ],
  },
  {
    title: '2. What the Interface is, and what it is not',
    blocks: [
      'The Interface is a non-custodial front end. It helps you find a price for a token swap on the Stellar network across public venues (the Stellar DEX, automated market makers, our own peer-to-peer order book, time-weighted execution, and request-for-quote (RFQ) settlement with independent market makers), builds a transaction that expresses your instruction, and hands that transaction to your wallet. Your wallet signs it. You submit it, or we relay it unchanged at your request.',
      'We never hold, control, or have access to your funds or private keys. We cannot reverse, cancel, or alter a transaction once it has been signed and submitted. We cannot recover funds sent to the wrong address or lost through a wallet compromise.',
      'The smart contracts the Interface uses (the "Protocol") are deployed on the public Stellar network and are open source under the Apache-2.0 license. Anyone can interact with them without the Interface. These Terms govern the Interface and the API, not the Protocol itself. The Protocol contracts have not been audited by an independent security firm.',
      'The Interface is a tool. We are not a broker, dealer, exchange, transfer agent, money transmitter, custodian, investment adviser, or fiduciary, and we do not act as your agent or counterparty. Prices, routes, reference values and estimates shown on the Interface are informational; the only binding terms of any transaction are those encoded in the transaction your wallet signs.',
    ],
  },
  {
    title: '3. Eligibility',
    blocks: [
      'You may use the Interface only if all of the following are true:',
      {
        list: [
          'You are at least 18 years old and have the legal capacity to enter into these Terms.',
          'You are not a resident of, located in, or organized under the laws of a country or territory subject to comprehensive U.S. sanctions (at the time of writing: Cuba, Iran, North Korea, Syria, and the Crimea, Donetsk and Luhansk regions of Ukraine), and you are not a person listed on, or owned or controlled by a person listed on, any U.S. (OFAC), U.N., U.K. or E.U. sanctions list.',
          'Your use of the Interface does not violate any law or regulation that applies to you, including securities, commodities, tax, and anti-money-laundering laws of your jurisdiction.',
          'You are not using the Interface on behalf of a person who could not meet these conditions.',
        ],
      },
      'We may restrict or block access from any jurisdiction, address or wallet at our discretion, including through geographic or address-based screening, and we may do so without notice.',
    ],
  },
  {
    title: '4. Tokenized real-world assets',
    blocks: [
      'The Interface can route swaps into and out of tokens that represent, or are backed by, real-world assets such as government securities or money-market instruments (for example, tokenized U.S. Treasury bills, Mexican CETES, or Brazilian Tesouro instruments). These tokens are issued and administered by third parties, not by us.',
      'Each issuer sets its own terms, including who may hold its token. Many tokenized securities are not offered to U.S. persons, or require investor verification, and transfers may be restricted or reversed by the issuer under its own rules. The Interface does not check your eligibility against an issuer’s terms. You are solely responsible for confirming that you may lawfully acquire and hold any token before you transact, and for any consequences of holding a token you were not eligible to hold.',
      'Net asset value (NAV) figures shown on the Interface come from on-chain oracles or from an issuer’s published data. They may be delayed, stale, or wrong. The RFQ settlement contract enforces a price band against an on-chain oracle where one is configured, but the band is a limit, not a guarantee of fair value. Nothing on the Interface is an offer, solicitation, or recommendation to buy or sell any security or other asset.',
    ],
  },
  {
    title: '5. Fees',
    blocks: [
      'The Protocol charges a fee that is taken on-chain from the output of each transaction and sent to a fee vault contract. The fee for each venue is recorded in the contract and can be read on-chain by anyone; the caps are fixed in the contract code and cannot be raised without deploying new contracts. At the revision date of these Terms:',
      {
        table: [
          ['Venue', 'Protocol fee', 'Hard cap in code'],
          ['Instant swap (router across external venues)', '0 bps', '0.5 bps'],
          ['Peer-to-peer order book', '0.5 bps', '0.5 bps'],
          ['RFQ settlement (taker side)', '0.5 bps', '0.5 bps'],
          ['TWAP (time-weighted execution)', '10 bps', '10 bps'],
        ],
      },
      'These fees are separate from (a) network fees paid to Stellar validators, (b) fees charged by external venues your route passes through, and (c) any partner fee that an application integrating our API adds for its own users, which that application must disclose and which is shown in the quote. Fees are non-refundable once a transaction is confirmed.',
    ],
  },
  {
    title: '6. Request-for-quote (RFQ) and market makers',
    blocks: [
      'In RFQ mode you broadcast a request and independent market makers may respond with signed quotes. A quote is an offer from that maker alone. We are not a party to it, do not guarantee that any maker will respond, that a quote will remain valid, or that settlement will succeed. A quote settles only if your wallet signs it before it expires and the on-chain checks pass.',
      'If you act as a market maker, you are responsible for the keys and inventory of your quoting wallet, for the prices you sign, for any licensing or registration your activity requires, and for your own compliance with issuer eligibility rules. Maker API keys are issued and revoked at our discretion. A signed quote is binding on the maker once a taker settles it; the Protocol does not allow a maker to withdraw a signed quote other than by letting it expire or by its nonce being consumed.',
    ],
  },
  {
    title: '7. Risks you accept',
    blocks: [
      'Using the Interface and the Protocol involves risks that you accept in full, including:',
      {
        list: [
          'Smart-contract risk. The Protocol contracts are unaudited and may contain defects that cause loss of funds. Upgrades or replacements of contracts may change behavior.',
          'Oracle and data risk. Prices, NAVs and price bands depend on third-party oracles and issuer data that may be stale, manipulated or unavailable.',
          'Market risk. Token prices can move sharply; stablecoins and tokenized assets can trade away from their reference value or lose it entirely; liquidity can vanish.',
          'Execution risk. Your transaction may fail, be delayed, or execute at a worse price than quoted because of slippage, competing transactions, or network conditions. TWAP and standing orders may fill partially or not at all.',
          'Wallet and key risk. Loss or compromise of your keys or wallet software means loss of your assets. We cannot help recover them.',
          'Network risk. The Stellar network, RPC providers, oracles and hosting providers we rely on may be interrupted or discontinued.',
          'Legal and tax risk. Laws governing digital assets and tokenized securities vary by jurisdiction and change. You are responsible for your own taxes and reporting.',
          'Irreversibility. Blockchain transactions are final.',
        ],
      },
      'We do not provide investment, legal, tax or financial advice. Any information on the Interface, in our documentation, or in our communications is general and is not tailored to you.',
    ],
  },
  {
    title: '8. Prohibited conduct',
    blocks: [
      'You agree not to:',
      {
        list: [
          'Use the Interface for any unlawful purpose, including money laundering, terrorist financing, sanctions evasion, fraud, or market manipulation such as wash trading or spoofing.',
          'Use the Interface to acquire or transfer a token in violation of its issuer’s eligibility or transfer restrictions.',
          'Attack, probe, overload, or disrupt the Interface, the API, or any infrastructure we use, or circumvent rate limits, access controls or API keys.',
          'Scrape, copy or redistribute the Interface or its data except through the API as documented, or misrepresent your identity or affiliation when using the API.',
          'Use the Interface in a way that infringes anyone’s rights or that would subject us to regulation as a financial institution in any jurisdiction.',
        ],
      },
    ],
  },
  {
    title: '9. Third-party services',
    blocks: [
      'The Interface depends on services we do not control, including wallet software, Stellar RPC and Horizon providers, price oracles (such as Reflector and RedStone), token issuers (such as Etherfuse and Ondo), external trading venues, and our hosting providers. Their terms and privacy policies apply to your use of them. We are not responsible for their availability, accuracy or conduct.',
    ],
  },
  {
    title: '10. Open source and intellectual property',
    blocks: [
      'The source code of the Interface, the API, the SDK and the Protocol is published at ' + REPO_URL + ' under the Apache-2.0 license (the SDK under MIT). Those licenses govern your use of the code. These Terms govern your use of the hosted Interface and API. The name "Ufama", the logo, and the design of the site are ours and may not be used to imply endorsement or affiliation without permission.',
    ],
  },
  {
    title: '11. Disclaimer of warranties',
    blocks: [
      'THE INTERFACE, THE API AND THE PROTOCOL ARE PROVIDED "AS IS" AND "AS AVAILABLE", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, ACCURACY, OR UNINTERRUPTED OR ERROR-FREE OPERATION. WE DO NOT WARRANT THAT ANY PRICE, ROUTE, NAV OR ESTIMATE IS ACCURATE OR THAT ANY TRANSACTION WILL EXECUTE. SOME JURISDICTIONS DO NOT ALLOW THE EXCLUSION OF IMPLIED WARRANTIES, SO SOME OF THESE EXCLUSIONS MAY NOT APPLY TO YOU.',
    ],
  },
  {
    title: '12. Limitation of liability',
    blocks: [
      'TO THE FULLEST EXTENT PERMITTED BY LAW, WE AND ANY PERSON WORKING ON THE INTERFACE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, DIGITAL ASSETS, DATA OR GOODWILL, ARISING OUT OF OR RELATING TO THE INTERFACE, THE API OR THE PROTOCOL, HOWEVER CAUSED AND UNDER ANY THEORY OF LIABILITY, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.',
      'OUR TOTAL LIABILITY FOR ALL CLAIMS RELATING TO THE INTERFACE, THE API OR THE PROTOCOL WILL NOT EXCEED THE GREATER OF (A) ONE HUNDRED U.S. DOLLARS (US$100) AND (B) THE PROTOCOL FEES YOU PAID THROUGH THE INTERFACE IN THE TWELVE MONTHS BEFORE THE CLAIM AROSE.',
      'Nothing in these Terms limits liability that cannot be limited by law, including for fraud or willful misconduct.',
    ],
  },
  {
    title: '13. Indemnification',
    blocks: [
      'You will defend, indemnify and hold harmless us and any person working on the Interface from any claim, loss, liability, cost or expense (including reasonable attorneys’ fees) arising from your use of the Interface, the API or the Protocol, your breach of these Terms, your violation of any law or third-party right, or any token you acquired in violation of an issuer’s restrictions.',
    ],
  },
  {
    title: '14. Dispute resolution, governing law, and class-action waiver',
    blocks: [
      'Informal resolution first. Before starting any formal proceeding, you agree to email ' + LEGAL_CONTACT + ' with a description of the dispute and to try in good faith to resolve it for at least 30 days.',
      'Arbitration. Any dispute that is not resolved informally will be settled by binding individual arbitration administered by the American Arbitration Association under its Consumer Arbitration Rules, rather than in court, except that either party may bring an individual claim in small-claims court or seek an injunction to protect intellectual property. The Federal Arbitration Act governs this clause. You may opt out of arbitration by emailing ' + LEGAL_CONTACT + ' within 30 days of first accepting these Terms, stating that you opt out.',
      'Class-action waiver. Disputes will be resolved only on an individual basis. You and we each waive any right to bring or participate in a class, collective, consolidated or representative action. If this waiver is found unenforceable for a particular claim, that claim must be brought in court, not arbitration.',
      'Governing law. These Terms and any dispute are governed by the laws of the State of ' + GOVERNING_STATE + ', United States, without regard to its conflict-of-laws rules, and, for anything not subject to arbitration, by the state and federal courts located in ' + GOVERNING_STATE + '.',
      'Time limit. Any claim must be brought within one year after it arises, or it is permanently barred.',
    ],
  },
  {
    title: '15. General',
    blocks: [
      {
        list: [
          'Suspension and termination. We may suspend, restrict or discontinue the Interface or the API, or your access to them, at any time, with or without notice. Sections 4, 5 and 7 through 15 survive termination. The Protocol contracts remain usable without the Interface.',
          'No waiver; severability. A failure to enforce a provision is not a waiver. If any provision is unenforceable, the rest remains in effect.',
          'Assignment. You may not assign these Terms. We may assign them to a successor operator of the Interface.',
          'Entire agreement. These Terms and the Privacy Notice are the entire agreement between you and us about the Interface and replace any earlier agreement.',
          'Contact. Questions about these Terms: ' + LEGAL_CONTACT + '.',
        ],
      },
    ],
  },
];

const wrap: React.CSSProperties = { maxWidth: '860px', margin: '0 auto', padding: '32px 24px 64px' };
const h1: React.CSSProperties = { fontSize: '26px', fontWeight: 700, color: '#e1e4ea', marginBottom: '6px' };
const section: React.CSSProperties = {
  background: '#131722',
  border: '1px solid #252a3a',
  borderRadius: '14px',
  padding: '22px',
  marginBottom: '16px',
};
const h2: React.CSSProperties = { fontSize: '16px', fontWeight: 700, color: '#e1e4ea', marginBottom: '10px' };
const p: React.CSSProperties = { fontSize: '14px', color: '#8a8f9c', lineHeight: 1.65, marginBottom: '10px' };
const li: React.CSSProperties = { ...p, marginBottom: '6px' };
const td: React.CSSProperties = { padding: '8px 10px', borderBottom: '1px solid #1a1f2e', fontSize: '13px', color: '#c4cad6' };

function renderBlock(b: Block, i: number) {
  if (typeof b === 'string') return <p key={i} style={p}>{b}</p>;
  if ('list' in b) {
    return (
      <ul key={i} style={{ paddingLeft: '20px', marginBottom: '10px' }}>
        {b.list.map((item, j) => <li key={j} style={li}>{item}</li>)}
      </ul>
    );
  }
  const [head, ...rows] = b.table;
  return (
    <table key={i} style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '12px' }}>
      <thead>
        <tr>{head.map((h, j) => <th key={j} style={{ ...td, textAlign: 'left', color: '#8a8f9c', fontWeight: 600 }}>{h}</th>)}</tr>
      </thead>
      <tbody>
        {rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k} style={td}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  );
}

export default function TermsPage() {
  return (
    <div style={wrap}>
      <h1 style={h1}>Terms of Use</h1>
      <p style={{ ...p, marginBottom: '24px' }}>
        Revision {TERMS_VERSION}. Please read these Terms carefully; they include a mandatory arbitration
        clause and a class-action waiver (section 14), and limits on our liability (sections 11 to 13).
        Our <a href="/privacy" style={{ color: '#818cf8' }}>Privacy Notice</a> is part of these Terms.
      </p>
      {SECTIONS.map((s) => (
        <div key={s.title} style={section}>
          <div style={h2}>{s.title}</div>
          {s.blocks.map(renderBlock)}
        </div>
      ))}
    </div>
  );
}
