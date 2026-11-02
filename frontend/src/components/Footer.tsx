import { REPO_URL } from '@/lib/legal';

const link: React.CSSProperties = { color: '#8a8f9c', textDecoration: 'none', fontWeight: 500 };

/** Site-wide footer: provenance, build id and the legal pages. */
export default function Footer() {
  return (
    <footer
      style={{
        position: 'relative',
        zIndex: 1,
        textAlign: 'center',
        padding: '24px 24px 40px',
        fontSize: '12px',
        color: '#565b68',
        lineHeight: 2,
      }}
    >
      <div>
        Built on <span style={{ color: '#8a8f9c', fontWeight: 500 }}>Stellar</span>
        {' '}&middot;{' '}
        Powered by <span style={{ color: '#8a8f9c', fontWeight: 500 }}>Soroban</span>
        {' '}&middot;{' '}
        <span title="Build version" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
          {process.env.NEXT_PUBLIC_BUILD_SHA}
        </span>
      </div>
      <div>
        <a href="/terms" style={link}>Terms of Use</a>
        {' '}&middot;{' '}
        <a href="/privacy" style={link}>Privacy Notice</a>
        {' '}&middot;{' '}
        <a href="/docs" style={link}>API</a>
        {' '}&middot;{' '}
        <a href={REPO_URL} target="_blank" rel="noopener" style={link}>Source (Apache-2.0)</a>
      </div>
      <div style={{ maxWidth: '720px', margin: '4px auto 0', lineHeight: 1.5 }}>
        Non-custodial interface to unaudited smart contracts. Not investment, legal or tax advice.
        Tokenized assets are issued by third parties with their own eligibility rules.
      </div>
    </footer>
  );
}
