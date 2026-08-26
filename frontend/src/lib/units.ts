/**
 * Decimal-aware amount conversion. Most Stellar assets (SACs) are 7
 * decimals, but Soroban-native tokens can differ — Sushi lists 18-decimal
 * tokens like deJTRSY/deJAAA. String math throughout: Number can't
 * represent 18-decimal base units without corrupting the low digits.
 */

/** Human-entered decimal string -> integer base units (as a string). */
export function toBaseUnits(amount: string, decimals: number): string {
  const clean = amount.trim();
  if (!/^\d*(\.\d*)?$/.test(clean) || clean === '' || clean === '.') return '0';
  const [whole = '0', frac = ''] = clean.split('.');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const combined = `${whole}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return combined === '' ? '0' : combined;
}

/** Integer base-unit string -> Number of whole tokens (display only). */
export function fromBaseUnits(raw: string | number | bigint, decimals: number): number {
  try {
    const v = BigInt(raw);
    const base = 10n ** BigInt(decimals);
    const whole = v / base;
    const frac = v % base;
    // 12 fractional digits: enough that a $2 BTC-denominated amount
    // (~1.75e-5) keeps 4+ significant digits; the quotient stays well
    // inside Number's exact-integer range.
    const fracNum = Number((frac * 1_000_000_000_000n) / base) / 1e12;
    return Number(whole) + fracNum;
  } catch {
    return 0;
  }
}

/**
 * Formatted display string for a base-unit amount.
 *
 * Without an explicit `fractionDigits`, precision adapts to the value —
 * the significant-digits convention DEX UIs use (Sushi/Uniswap show ~6
 * sig figs): a $2 BTC buy reads 0.0000175 (not 0.00) and a deJAAA quote
 * reads 1.891478 (not 1.89). Always at least 2 decimals; capped at the
 * token's own decimals and 12 places.
 */
export function formatUnits(
  raw: string | number | bigint,
  decimals: number,
  fractionDigits?: number
): string {
  const v = fromBaseUnits(raw, decimals);
  if (fractionDigits !== undefined) {
    return v.toLocaleString('en-US', {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
  }
  const abs = Math.abs(v);
  if (abs === 0) {
    return '0.00';
  }
  // Decimals needed so ~6 significant digits survive. For values ≥ 1 the
  // integer part supplies some of them; below 1 the leading zeros don't.
  const sigDecimals =
    abs >= 1
      ? 6 - (Math.floor(Math.log10(abs)) + 1)
      : -Math.floor(Math.log10(abs)) + 5;
  const maxDigits = Math.min(Math.max(2, sigDecimals), decimals, 12);
  return v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDigits,
  });
}
