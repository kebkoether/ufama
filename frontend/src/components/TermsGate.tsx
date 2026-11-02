'use client';

import { useState } from 'react';
import { ACK_STATEMENTS, TERMS_VERSION } from '@/lib/legal';

/**
 * First-connect acknowledgment. Shown by WalletProvider before the wallet
 * picker opens (and before any signature) until the current TERMS_VERSION
 * has been accepted on this browser. Clickwrap: affirmative checkbox plus
 * an explicit "I agree" button, with the full documents one click away.
 */
export default function TermsGate({
  open,
  onDecide,
}: {
  open: boolean;
  onDecide: (accepted: boolean) => void;
}) {
  const [checked, setChecked] = useState(false);
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-gate-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        background: 'rgba(5, 7, 10, 0.78)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px',
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onDecide(false);
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '520px',
          background: '#131722',
          border: '1px solid #252a3a',
          borderRadius: '16px',
          padding: '24px',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
        }}
      >
        <div id="terms-gate-title" style={{ fontSize: '18px', fontWeight: 700, color: '#e1e4ea', marginBottom: '6px' }}>
          Before you connect
        </div>
        <p style={{ fontSize: '13px', color: '#8a8f9c', lineHeight: 1.6, marginBottom: '16px' }}>
          Ufama is a non-custodial interface to public smart contracts on Stellar. Your wallet signs
          every transaction; we never hold your keys or funds. Please confirm the following.
        </p>

        <ul style={{ listStyle: 'none', display: 'grid', gap: '10px', marginBottom: '18px' }}>
          {ACK_STATEMENTS.map((s, i) => (
            <li key={i} style={{ display: 'flex', gap: '10px', fontSize: '13px', color: '#c4cad6', lineHeight: 1.55 }}>
              <span style={{ color: '#6366f1', fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
              <span>{s}</span>
            </li>
          ))}
        </ul>

        <label
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: '10px',
            padding: '12px',
            background: '#0d1117',
            border: '1px solid #1a1f2e',
            borderRadius: '10px',
            cursor: 'pointer',
            marginBottom: '16px',
            fontSize: '13px',
            color: '#e1e4ea',
            lineHeight: 1.5,
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            style={{ marginTop: '3px', width: '16px', height: '16px', accentColor: '#6366f1', flexShrink: 0 }}
          />
          <span>
            I confirm all three statements and accept the{' '}
            <a href="/terms" target="_blank" rel="noopener" style={{ color: '#818cf8' }}>Terms of Use</a>
            {' '}and{' '}
            <a href="/privacy" target="_blank" rel="noopener" style={{ color: '#818cf8' }}>Privacy Notice</a>
            {' '}(revision {TERMS_VERSION}).
          </span>
        </label>

        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => onDecide(false)}
            style={{
              background: 'transparent',
              color: '#8a8f9c',
              border: '1px solid #252a3a',
              borderRadius: '10px',
              padding: '10px 16px',
              fontSize: '14px',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => onDecide(true)}
            disabled={!checked}
            style={{
              background: checked ? 'linear-gradient(135deg, #6366f1, #7c3aed)' : '#1a1f2e',
              color: checked ? 'white' : '#565b68',
              border: 'none',
              borderRadius: '10px',
              padding: '10px 18px',
              fontSize: '14px',
              fontWeight: 600,
              cursor: checked ? 'pointer' : 'not-allowed',
            }}
          >
            I agree, continue
          </button>
        </div>
      </div>
    </div>
  );
}
