/**
 * Legal constants shared by the Terms / Privacy pages and the
 * first-connect acknowledgment gate.
 *
 * Bump TERMS_VERSION whenever the Terms or Privacy Notice change in a
 * way users must re-accept; every wallet will see the gate once more.
 */

/** ISO date of the current Terms + Privacy Notice revision. */
export const TERMS_VERSION = '2026-11-02';

/** Who runs the hosted interface. Fill in once an entity exists. */
export const OPERATOR_NAME = 'the operator of ufama.trade';
/** US state whose law governs the Terms (e.g. "Delaware"). Required before launch. */
export const GOVERNING_STATE = 'California';
export const LEGAL_CONTACT = 'legal@ufama.trade';
export const SITE = 'ufama.trade';
export const REPO_URL = 'https://github.com/kebkoether/ufama';

export const ACK_STORAGE_KEY = 'ufama.terms-ack'; // value: TERMS_VERSION

export function hasAcceptedTerms(): boolean {
  try {
    return localStorage.getItem(ACK_STORAGE_KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
}

export function recordTermsAcceptance(): void {
  try {
    localStorage.setItem(ACK_STORAGE_KEY, TERMS_VERSION);
  } catch {}
}

/** The statements a user affirms before connecting a wallet. */
export const ACK_STATEMENTS = [
  'I have read and agree to the Terms of Use and the Privacy Notice.',
  'I am not a resident of, or located in, a jurisdiction subject to comprehensive U.S. sanctions, and I am not on any sanctions list.',
  'I understand that the smart contracts are unaudited, that transactions on Stellar are irreversible, and that tokenized real-world assets are issued by third parties with their own eligibility rules that this interface does not check.',
] as const;
