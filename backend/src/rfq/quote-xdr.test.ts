import { describe, it, expect } from 'vitest';
import { Keypair, Networks, StrKey, authorizeInvocation, xdr, Address } from '@stellar/stellar-sdk';
import {
  decodeQuoteEntry,
  entryAddress,
  isSourceAccountEntry,
  quoteFromScVal,
  quoteToScVal,
  randomNonce,
  vsFairBps,
  QuoteFields,
} from './quote-xdr.js';

const RFQ = StrKey.encodeContract(Buffer.alloc(32, 7));
const OTHER = StrKey.encodeContract(Buffer.alloc(32, 9));
const USDC = StrKey.encodeContract(Buffer.alloc(32, 1));
const BOND = StrKey.encodeContract(Buffer.alloc(32, 2));

function sampleQuote(maker: string, taker: string): QuoteFields {
  return {
    maker,
    taker,
    tokenIn: USDC,
    tokenOut: BOND,
    amountIn: 1_050_0000000n,
    amountOut: 100_0000000n,
    expiryLedger: 5_000_123,
    nonce: 18446744073709551615n, // u64 max
    maxNavDevBps: 25,
  };
}

function invocation(contract: string, fn: string, args: xdr.ScVal[]) {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(contract).toScAddress(),
        functionName: fn,
        args,
      })
    ),
    subInvocations: [],
  });
}

describe('quote struct encoding', () => {
  it('round-trips through the Soroban struct map', () => {
    const q = sampleQuote(Keypair.random().publicKey(), Keypair.random().publicKey());
    expect(quoteFromScVal(quoteToScVal(q))).toEqual(q);
  });

  it('rejects a struct with a non-address field', () => {
    const bad = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('maker'), val: xdr.ScVal.scvU32(1) }),
    ]);
    expect(() => quoteFromScVal(bad)).toThrow(/maker/);
  });

  it('random nonces are u64 and distinct', () => {
    const a = randomNonce();
    const b = randomNonce();
    expect(a).not.toBe(b);
    expect(a >= 0n && a <= 18446744073709551615n).toBe(true);
  });
});

describe('maker auth entry decoding', () => {
  const maker = Keypair.random();
  const taker = Keypair.random().publicKey();
  const q = sampleQuote(maker.publicKey(), taker);

  for (const authV2 of [false, true]) {
    it(`decodes a signed entry (authV2=${authV2})`, async () => {
      const entry = await authorizeInvocation({
        signer: maker,
        validUntilLedgerSeq: q.expiryLedger,
        invocation: invocation(RFQ, 'settle_quote', [quoteToScVal(q)]),
        networkPassphrase: Networks.TESTNET,
        authV2,
      });
      const d = decodeQuoteEntry(entry.toXDR('base64'), RFQ);
      expect(d.signer).toBe(maker.publicKey());
      expect(d.signed).toBe(true);
      expect(d.signatureExpirationLedger).toBe(q.expiryLedger);
      expect(d.contract).toBe(RFQ);
      expect(d.functionName).toBe('settle_quote');
      expect(d.quote).toEqual(q);
      expect(typeof d.credentialNonce).toBe('bigint');
      expect(entryAddress(entry)).toBe(maker.publicKey());
      expect(isSourceAccountEntry(entry)).toBe(false);
    });
  }

  it('rejects an entry for another contract or function', async () => {
    const wrongContract = await authorizeInvocation({
      signer: maker,
      validUntilLedgerSeq: 1,
      invocation: invocation(OTHER, 'settle_quote', [quoteToScVal(q)]),
      networkPassphrase: Networks.TESTNET,
    });
    expect(() => decodeQuoteEntry(wrongContract.toXDR('base64'), RFQ)).toThrow(/other than the RFQ/);
    const wrongFn = await authorizeInvocation({
      signer: maker,
      validUntilLedgerSeq: 1,
      invocation: invocation(RFQ, 'set_fee', [xdr.ScVal.scvI128(new xdr.Int128Parts({ hi: xdr.Int64.fromString('0'), lo: xdr.Uint64.fromString('5') }))]),
      networkPassphrase: Networks.TESTNET,
    });
    expect(() => decodeQuoteEntry(wrongFn.toXDR('base64'), RFQ)).toThrow(/expected settle_quote/);
  });

  it('rejects a signer who is not the quoted maker', async () => {
    const impostor = Keypair.random();
    const entry = await authorizeInvocation({
      signer: impostor,
      validUntilLedgerSeq: 1,
      invocation: invocation(RFQ, 'settle_quote', [quoteToScVal(q)]),
      networkPassphrase: Networks.TESTNET,
    });
    expect(() => decodeQuoteEntry(entry.toXDR('base64'), RFQ)).toThrow(/does not match quote.maker/);
  });

  it('flags an unsigned (recording-mode) entry', () => {
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(maker.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString('42') as any,
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: invocation(RFQ, 'settle_quote', [quoteToScVal(q)]),
    });
    const d = decodeQuoteEntry(unsigned.toXDR('base64'), RFQ);
    expect(d.signed).toBe(false);
    expect(d.credentialNonce).toBe(42n);
  });

  it('rejects garbage and source-account credentials', () => {
    expect(() => decodeQuoteEntry('not-xdr', RFQ)).toThrow(/not a valid/);
    const src = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: invocation(RFQ, 'settle_quote', [quoteToScVal(q)]),
    });
    expect(isSourceAccountEntry(src)).toBe(true);
    expect(() => decodeQuoteEntry(src.toXDR('base64'), RFQ)).toThrow(/address credentials/);
  });
});

describe('vsFairBps', () => {
  it('is positive when short of fair, negative when generous, 0.1 bps resolution', () => {
    expect(vsFairBps(100_0000000n, 99_8000000n)).toBe(20);
    expect(vsFairBps(100_0000000n, 100_1000000n)).toBe(-10);
    expect(vsFairBps(100_0000000n, 100_0000000n)).toBe(0);
    expect(vsFairBps(0n, 1n)).toBeNull();
  });
});
