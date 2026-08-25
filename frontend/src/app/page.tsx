'use client';

import { useState } from 'react';
import SwapWidget from '@/components/SwapWidget';
import RoutePreview from '@/components/RoutePreview';

export default function Home() {
  const [route, setRoute] = useState<any>(null);

  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '0 auto',
        padding: '40px 16px 80px',
      }}
    >
      {/* Hero */}
      <div style={{ textAlign: 'center', marginBottom: '28px' }}>
        <h1
          style={{
            fontSize: '28px',
            fontWeight: 700,
            color: '#e1e4ea',
            letterSpacing: '-0.5px',
            marginBottom: '8px',
          }}
        >
          The cheapest swap on Stellar
        </h1>
        <p style={{ fontSize: '14px', color: '#8a8f9c', lineHeight: '1.6' }}>
          <strong style={{ color: '#e1e4ea' }}>Instant Swap</strong> routes through the
          best DEX price.{' '}
          <strong style={{ color: '#e1e4ea' }}>P2P Match</strong> finds you a peer at just{' '}
          <span style={{ color: '#6366f1', fontWeight: 600 }}>0.5 bps</span>.
        </p>
      </div>

      {/* Swap Widget */}
      <SwapWidget onRouteComputed={setRoute} />

      {/* Route Preview */}
      {route && route.segments && route.segments.length > 0 && (
        <div style={{ marginTop: '12px' }}>
          <RoutePreview route={route} />
        </div>
      )}

      {/* How it works */}
      <div
        style={{
          marginTop: '40px',
          background: '#131722',
          border: '1px solid #1a1f2e',
          borderRadius: '16px',
          padding: '20px',
        }}
      >
        <div
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: '#8a8f9c',
            marginBottom: '16px',
          }}
        >
          How it works
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {[
            {
              num: '1',
              title: 'Instant Swap',
              desc: 'Fill now. We split your trade across the best venues — our orderbook, Stellar DEX, Aqua, and SushiSwap.',
              fee: 'Venue fees only — no markup',
              feeColor: '#eab308',
            },
            {
              num: '2',
              title: 'P2P Match',
              desc: 'Wait & save. We check for matching peers first — any matches fill instantly. The rest is escrowed on-chain until a counterparty appears. Cancel anytime.',
              fee: '0.5 bps only · could take minutes to days',
              feeColor: '#22c55e',
            },
          ].map((step) => (
            <div key={step.num} style={{ display: 'flex', gap: '14px' }}>
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  borderRadius: '8px',
                  background: 'rgba(99, 102, 241, 0.1)',
                  color: '#6366f1',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '13px',
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {step.num}
              </div>
              <div>
                <div
                  style={{
                    fontSize: '14px',
                    fontWeight: 600,
                    color: '#e1e4ea',
                    marginBottom: '4px',
                  }}
                >
                  {step.title}
                </div>
                <div style={{ fontSize: '13px', color: '#8a8f9c', lineHeight: '1.5' }}>
                  {step.desc}
                </div>
                <div
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: step.feeColor,
                    marginTop: '4px',
                  }}
                >
                  {step.fee}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          textAlign: 'center',
          marginTop: '32px',
          fontSize: '12px',
          color: '#565b68',
        }}
      >
        Built on{' '}
        <span style={{ color: '#8a8f9c', fontWeight: 500 }}>Stellar</span>
        {' '}&middot;{' '}
        Powered by{' '}
        <span style={{ color: '#8a8f9c', fontWeight: 500 }}>Soroban</span>
        {' '}&middot;{' '}
        <span title="Build version" style={{ fontFamily: 'monospace', fontSize: '11px' }}>
          {process.env.NEXT_PUBLIC_BUILD_SHA}
        </span>
      </div>
    </div>
  );
}
