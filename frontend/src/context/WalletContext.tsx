'use client';

import { createContext, useContext, useState, useCallback, useEffect, useRef, ReactNode } from 'react';
import TermsGate from '@/components/TermsGate';
import { hasAcceptedTerms, recordTermsAcceptance } from '@/lib/legal';

/**
 * Wallet context backed by Stellar Wallets Kit v2 — one integration for
 * Freighter, xBull, LOBSTR, Albedo, Hana, Rabet, Ledger, Trezor, Fordefi,
 * HOT Wallet and more (kit's default module set).
 *
 * The kit is imported dynamically inside callbacks so nothing touches
 * window/document during Next.js prerender.
 */

/** The network this app is built against. Signing is pinned to it. */
const EXPECTED_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';

// NOTE: key intentionally keeps the legacy name — renaming it would silently
// disconnect every existing user's wallet session on the rebrand deploy.
const STORAGE_KEY = 'atomicswap.wallet'; // { walletId, address }

let kitReady = false;

async function getKit() {
  const [{ StellarWalletsKit, Networks }, { defaultModules }] = await Promise.all([
    import('@creit.tech/stellar-wallets-kit'),
    import('@creit.tech/stellar-wallets-kit/modules/utils'),
  ]);
  if (!kitReady) {
    StellarWalletsKit.init({
      modules: defaultModules(),
      network: EXPECTED_PASSPHRASE.startsWith('Public Global')
        ? Networks.PUBLIC
        : Networks.TESTNET,
    });
    kitReady = true;
  }
  return StellarWalletsKit;
}

interface WalletState {
  connected: boolean;
  address: string | null;
  network: string | null;
  networkPassphrase: string | null;
  /** True when the wallet reports a different network than the app expects. */
  networkMismatch: boolean;
  loading: boolean;
}

interface WalletContextType extends WalletState {
  expectedNetworkPassphrase: string;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
}

const WalletContext = createContext<WalletContextType | null>(null);

const DISCONNECTED: WalletState = {
  connected: false,
  address: null,
  network: null,
  networkPassphrase: null,
  networkMismatch: false,
  loading: false,
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>(DISCONNECTED);

  // First-connect acknowledgment (Terms + Privacy + eligibility). Resolves
  // true once the current TERMS_VERSION is accepted on this browser; a
  // declined gate resolves false and the caller backs out quietly.
  const [gateOpen, setGateOpen] = useState(false);
  const gateResolver = useRef<((ok: boolean) => void) | null>(null);
  const ensureTermsAccepted = useCallback((): Promise<boolean> => {
    if (hasAcceptedTerms()) return Promise.resolve(true);
    return new Promise((resolve) => {
      gateResolver.current?.(false);
      gateResolver.current = resolve;
      setGateOpen(true);
    });
  }, []);
  const decideGate = useCallback((accepted: boolean) => {
    setGateOpen(false);
    if (accepted) recordTermsAcceptance();
    const r = gateResolver.current;
    gateResolver.current = null;
    r?.(accepted);
  }, []);

  const applyConnection = useCallback((address: string, networkPassphrase: string | null) => {
    setState({
      connected: true,
      address,
      network: networkPassphrase
        ? networkPassphrase.startsWith('Public Global') ? 'PUBLIC' : 'TESTNET'
        : null,
      networkPassphrase,
      networkMismatch:
        networkPassphrase !== null && networkPassphrase !== EXPECTED_PASSPHRASE,
      loading: false,
    });
  }, []);

  // Restore a previous session (same wallet, silent where the wallet allows)
  useEffect(() => {
    (async () => {
      if (typeof window === 'undefined') return;
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const { walletId, address } = JSON.parse(raw);
        if (!walletId || !address) return;
        const kit = await getKit();
        kit.setWallet(walletId);
        // Confirm the wallet still grants access — silent for authorized
        // extensions; if it prompts or fails, stay disconnected.
        const fetched = await kit.fetchAddress().catch(() => null);
        if (fetched?.address) {
          let passphrase: string | null = null;
          try {
            passphrase = (await kit.getNetwork()).networkPassphrase;
          } catch {}
          applyConnection(fetched.address, passphrase);
        }
      } catch {
        // No restore — user connects manually
      }
    })();
  }, [applyConnection]);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (!(await ensureTermsAccepted())) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const kit = await getKit();
      const { address } = await kit.authModal();
      if (!address) {
        setState((s) => ({ ...s, loading: false }));
        return;
      }
      let passphrase: string | null = null;
      try {
        passphrase = (await kit.getNetwork()).networkPassphrase;
      } catch {
        // Some wallets don't expose their network — signing still pins
        // the passphrase explicitly, so this is informational only.
      }
      try {
        const { StellarWalletsKit } = await import('@creit.tech/stellar-wallets-kit');
        const walletId = StellarWalletsKit.selectedModule?.productId ?? null;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ walletId, address }));
      } catch {}
      applyConnection(address, passphrase);
    } catch (error: any) {
      // Modal dismissed or connection refused — stay disconnected quietly
      if (!/closed|cancel/i.test(error?.message ?? '')) {
        console.error('Wallet connection failed:', error);
      }
      setState((s) => ({ ...s, loading: false }));
    }
  }, [applyConnection, ensureTermsAccepted]);

  const disconnect = useCallback(() => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
    getKit()
      .then((kit) => kit.disconnect())
      .catch(() => {});
    setState(DISCONNECTED);
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      if (!state.connected || !state.address) {
        throw new Error('Wallet not connected');
      }
      // Sessions restored from before the Terms shipped (or after a Terms
      // revision) see the acknowledgment before their next signature.
      if (!(await ensureTermsAccepted())) {
        throw new Error('You need to accept the Terms of Use before signing');
      }
      const kit = await getKit();

      // Network guard: if the wallet reports its network and it isn't ours,
      // refuse before prompting a signature.
      try {
        const { networkPassphrase } = await kit.getNetwork();
        if (networkPassphrase && networkPassphrase !== EXPECTED_PASSPHRASE) {
          throw new Error(
            `Wrong network: your wallet is on a different network than this app ` +
            `("${EXPECTED_PASSPHRASE}"). Switch networks in your wallet and try again.`
          );
        }
      } catch (e: any) {
        if (/Wrong network/.test(e?.message ?? '')) throw e;
        // Wallet doesn't support network introspection — proceed; the
        // explicit passphrase below still scopes the signature.
      }

      const result = await kit.signTransaction(xdr, {
        networkPassphrase: EXPECTED_PASSPHRASE,
        address: state.address,
      });
      if (!result?.signedTxXdr) {
        throw new Error('Signing failed or was rejected in the wallet');
      }
      return result.signedTxXdr;
    },
    [state.connected, state.address, ensureTermsAccepted]
  );

  return (
    <WalletContext.Provider
      value={{
        ...state,
        expectedNetworkPassphrase: EXPECTED_PASSPHRASE,
        connect,
        disconnect,
        signTransaction,
      }}
    >
      {children}
      <TermsGate open={gateOpen} onDecide={decideGate} />
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return ctx;
}
