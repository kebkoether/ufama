import { describe, it, expect } from 'vitest';
import {
  impactFlags,
  impactViolation,
  normalizeImpact,
  sumHopImpact,
  PRICE_IMPACT_MAX_BPS,
  PRICE_IMPACT_WARN_BPS,
} from './impact.js';

describe('price-impact guard', () => {
  it('normalizes junk to zero', () => {
    expect(normalizeImpact(undefined)).toBe(0);
    expect(normalizeImpact(null)).toBe(0);
    expect(normalizeImpact(NaN)).toBe(0);
    expect(normalizeImpact(-12)).toBe(0);
    expect(normalizeImpact(42.5)).toBe(42.5);
  });

  it('defaults: warn above 3%, block above 15%', () => {
    expect(PRICE_IMPACT_WARN_BPS).toBe(300);
    expect(PRICE_IMPACT_MAX_BPS).toBe(1500);
  });

  it('flags nothing on a normal trade', () => {
    const f = impactFlags(12);
    expect(f.priceImpactWarning).toBe(false);
    expect(f.priceImpactBlocked).toBe(false);
    expect(impactViolation(12)).toBeNull();
  });

  it('warns but allows between the thresholds', () => {
    const f = impactFlags(PRICE_IMPACT_WARN_BPS + 1);
    expect(f.priceImpactWarning).toBe(true);
    expect(f.priceImpactBlocked).toBe(false);
    expect(impactViolation(PRICE_IMPACT_WARN_BPS + 1)).toBeNull();
  });

  it('blocks above the cap with an actionable message', () => {
    const f = impactFlags(9999);
    expect(f.priceImpactBlocked).toBe(true);
    const msg = impactViolation(9999);
    expect(msg).toMatch(/100\.0%/);
    expect(msg).toMatch(/TWAP/);
    expect(msg).toMatch(/No funds were moved/);
  });

  it('exactly at the cap is still allowed (cap is inclusive)', () => {
    expect(impactViolation(PRICE_IMPACT_MAX_BPS)).toBeNull();
    expect(impactFlags(PRICE_IMPACT_MAX_BPS).priceImpactBlocked).toBe(false);
  });

  it('sums per-hop impact, ignoring negatives/missing', () => {
    const hops = [
      { route: { priceImpactBps: 100 } },
      { route: { priceImpactBps: -5 } },
      { route: {} },
      { route: { priceImpactBps: 250.5 } },
    ];
    expect(sumHopImpact(hops)).toBe(350.5);
  });
});
