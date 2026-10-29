/**
 * Signing helpers. These are the only places the SDK touches a key, and
 * the key is always yours: a Keypair or a callback you supply.
 */

import { Address, Keypair, authorizeEntry, xdr, Networks } from '@stellar/stellar-sdk';

export type SigningCallback = (preimage: xdr.HashIdPreimage) => Promise<Uint8Array>;

export const MAINNET_PASSPHRASE = Networks.PUBLIC;
export const TESTNET_PASSPHRASE = Networks.TESTNET;

/**
 * Sign the authorization entry returned by `rfq.prepare`, binding it to
 * exactly that quote until `expiryLedger`. Returns the signed entry as
 * base64 XDR, ready for `rfq.submitQuote`.
 *
 * `signer` is a Keypair (hot wallet / bot) or a callback that signs a
 * 32-byte payload hash (HSM, custody API, hardware wallet).
 */
export async function signQuoteEntry(
  authEntryXdr: string,
  signer: Keypair | SigningCallback,
  expiryLedger: number,
  networkPassphrase: string = MAINNET_PASSPHRASE
): Promise<string> {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
  const signed = await authorizeEntry(entry, signer as any, expiryLedger, networkPassphrase);
  return signed.toXDR('base64');
}

/** The maker address an unsigned/signed entry belongs to, for sanity checks. */
export function entrySigner(authEntryXdr: string): string | null {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, 'base64');
  const cred: any = entry.credentials;
  const ac = cred?.type === 'sorobanCredentialsAddress' ? cred.address : cred?.type === 'sorobanCredentialsAddressV2' ? cred.addressV2 : null;
  if (!ac) return null;
  return Address.fromScAddress(ac.address).toString();
}
