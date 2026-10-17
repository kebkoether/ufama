/**
 * Encoding/decoding of RFQ quotes and the maker's pre-signed Soroban
 * authorization entry. Pure functions — no network — so the decoder
 * that gates maker submissions is unit-tested in isolation.
 *
 * The maker signs ONE invocation: `settle_quote(quote)` on the RFQ
 * contract. Its authorization entry carries the full quote in the root
 * invocation's args, so the entry alone is the quote: what the backend
 * stores, verifies and later attaches to the taker's transaction.
 */

import { randomBytes } from 'node:crypto';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import { StellarClient } from '../stellar/client.js';

export interface QuoteFields {
  maker: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  expiryLedger: number;
  nonce: bigint;
  maxNavDevBps: number;
}

/** Soroban structs encode as maps with keys in sorted order. */
export function quoteToScVal(q: QuoteFields): xdr.ScVal {
  const entry = (key: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  return xdr.ScVal.scvMap([
    entry('amount_in', StellarClient.toI128(q.amountIn)),
    entry('amount_out', StellarClient.toI128(q.amountOut)),
    entry('expiry_ledger', StellarClient.toU32(q.expiryLedger)),
    entry('maker', StellarClient.toAddress(q.maker)),
    entry('max_nav_dev_bps', StellarClient.toU32(q.maxNavDevBps)),
    entry('nonce', StellarClient.toU64(q.nonce)),
    entry('taker', StellarClient.toAddress(q.taker)),
    entry('token_in', StellarClient.toAddress(q.tokenIn)),
    entry('token_out', StellarClient.toAddress(q.tokenOut)),
  ]);
}

export function quoteFromScVal(v: xdr.ScVal): QuoteFields {
  const n = scValToNative(v) as Record<string, unknown>;
  if (!n || typeof n !== 'object') throw new Error('quote arg is not a struct');
  const addr = (k: string) => {
    const s = n[k];
    if (typeof s !== 'string' || !/^[GC][A-Z2-7]{55}$/.test(s)) {
      throw new Error(`quote.${k} is not an address`);
    }
    return s;
  };
  const big = (k: string) => {
    const x = n[k];
    if (typeof x !== 'bigint' && typeof x !== 'number') throw new Error(`quote.${k} missing`);
    return BigInt(x);
  };
  const u32 = (k: string) => {
    const x = Number(n[k]);
    if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new Error(`quote.${k} is not u32`);
    return x;
  };
  return {
    maker: addr('maker'),
    taker: addr('taker'),
    tokenIn: addr('token_in'),
    tokenOut: addr('token_out'),
    amountIn: big('amount_in'),
    amountOut: big('amount_out'),
    expiryLedger: u32('expiry_ledger'),
    nonce: big('nonce'),
    maxNavDevBps: u32('max_nav_dev_bps'),
  };
}

/** Random u64 for Quote.nonce (the contract-level replay id). */
export function randomNonce(): bigint {
  return randomBytes(8).readBigUInt64BE();
}

export interface DecodedQuoteEntry {
  entry: xdr.SorobanAuthorizationEntry;
  /** Address the credentials belong to (must equal quote.maker). */
  signer: string;
  /** Host-level nonce from the credentials (distinct from quote.nonce). */
  credentialNonce: bigint;
  signatureExpirationLedger: number;
  signed: boolean;
  contract: string;
  functionName: string;
  quote: QuoteFields;
  subInvocations: number;
}

/** Address credentials in either CAP-71 shape. */
function addressCredentials(entry: xdr.SorobanAuthorizationEntry): any | null {
  const cred: any = entry.credentials;
  if (cred?.type === 'sorobanCredentialsAddress') return cred.address;
  if (cred?.type === 'sorobanCredentialsAddressV2') return cred.addressV2;
  return null;
}

export function isSourceAccountEntry(entry: xdr.SorobanAuthorizationEntry): boolean {
  return (entry.credentials as any)?.type === 'sorobanCredentialsSourceAccount';
}

export function entryAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const ac = addressCredentials(entry);
  return ac ? Address.fromScAddress(ac.address).toString() : null;
}

/**
 * Decode and shape-check a maker's authorization entry. Throws with a
 * specific reason when the entry is not a well-formed quote for the
 * given RFQ contract. Does NOT verify the signature — the enforce-mode
 * simulation that follows does that against the real host.
 */
export function decodeQuoteEntry(
  entryXdr: string,
  rfqContractId: string
): DecodedQuoteEntry {
  if (typeof entryXdr !== 'string' || entryXdr.length === 0 || entryXdr.length > 20_000) {
    throw new Error('authEntryXdr must be a base64 SorobanAuthorizationEntry');
  }
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, 'base64');
  } catch {
    throw new Error('authEntryXdr is not a valid SorobanAuthorizationEntry');
  }
  const ac = addressCredentials(entry);
  if (!ac) throw new Error('auth entry must carry address credentials (not source-account)');
  const signer = Address.fromScAddress(ac.address).toString();
  const nonceRaw: any = ac.nonce;
  const credentialNonce =
    typeof nonceRaw === 'bigint' ? nonceRaw : BigInt(nonceRaw?.toString?.() ?? 0);
  const signatureExpirationLedger = Number(ac.signatureExpirationLedger);
  const signed = (ac.signature as any)?.type !== 'scvVoid';

  const root: any = entry.rootInvocation;
  if (root?.function?.type !== 'sorobanAuthorizedFunctionTypeContractFn') {
    throw new Error('auth entry root must be a contract function invocation');
  }
  const cf = root.function.contractFn;
  const contract = Address.fromScAddress(cf.contractAddress).toString();
  const functionName = String(cf.functionName?.toString?.() ?? cf.functionName);
  if (contract !== rfqContractId) {
    throw new Error('auth entry targets a contract other than the RFQ settlement contract');
  }
  if (functionName !== 'settle_quote') {
    throw new Error(`auth entry authorizes ${functionName}, expected settle_quote`);
  }
  const args: xdr.ScVal[] = cf.args ?? [];
  if (args.length !== 1) throw new Error('settle_quote takes exactly one argument');
  const quote = quoteFromScVal(args[0]);
  if (quote.maker !== signer) {
    throw new Error('auth entry signer does not match quote.maker');
  }
  return {
    entry,
    signer,
    credentialNonce,
    signatureExpirationLedger,
    signed,
    contract,
    functionName,
    quote,
    subInvocations: Array.isArray(root.subInvocations) ? root.subInvocations.length : 0,
  };
}

/** Signed bps deviation of `out` from `fair`: positive = short of fair. */
export function vsFairBps(fair: bigint, out: bigint): number | null {
  if (fair <= 0n) return null;
  const diff = Number(fair - out);
  return Math.round((diff / Number(fair)) * 10_000 * 10) / 10;
}
