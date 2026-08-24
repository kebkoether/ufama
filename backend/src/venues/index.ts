/**
 * Venue registry — central place to register and access all venue adapters.
 */

import { VenueAdapter } from './adapter.js';
import { SwapBookAdapter } from './swapbook.js';
import { AquaAdapter, AquaPoolsProvider } from './aqua.js';
import { SushiSwapAdapter, SushiPairsProvider } from './sushiswap.js';
import { StellarDexAdapter } from './stellar-dex.js';
import { StellarClient } from '../stellar/client.js';

export class VenueRegistry {
  private venues: Map<number, VenueAdapter> = new Map();

  register(adapter: VenueAdapter): void {
    this.venues.set(adapter.venueId, adapter);
    console.log(`  Venue registered: ${adapter.name} (id=${adapter.venueId})`);
  }

  get(venueId: number): VenueAdapter | undefined {
    return this.venues.get(venueId);
  }

  getAll(): VenueAdapter[] {
    return Array.from(this.venues.values());
  }

  async getAvailable(): Promise<VenueAdapter[]> {
    const all = this.getAll();
    const checks = await Promise.all(
      all.map(async (v) => ({ adapter: v, available: await v.isAvailable() }))
    );
    return checks.filter((c) => c.available).map((c) => c.adapter);
  }
}

export function createVenueRegistry(config: {
  swapbookContractId: string;
  aquaAdapterContractId: string;
  aquaApiUrl: string;
  sushiAdapterContractId: string;
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Live Sushi pair source (token discovery); env SUSHI_PAIRS overrides */
  sushiPairsProvider?: SushiPairsProvider;
  /** Discovered Aqua pools per pair (token discovery) — quoting source */
  aquaPoolsProvider?: AquaPoolsProvider;
}): VenueRegistry {
  const registry = new VenueRegistry();

  // Shared Stellar RPC client
  const stellar = new StellarClient({
    rpcUrl: config.rpcUrl,
    networkPassphrase: config.networkPassphrase,
  });

  if (config.swapbookContractId) {
    registry.register(new SwapBookAdapter(config.swapbookContractId, stellar));
  }

  if (config.aquaAdapterContractId) {
    registry.register(
      new AquaAdapter(
        config.aquaAdapterContractId,
        config.aquaApiUrl,
        stellar,
        config.aquaPoolsProvider
      )
    );
  }

  if (config.sushiAdapterContractId) {
    registry.register(
      new SushiSwapAdapter(
        config.sushiAdapterContractId,
        stellar,
        process.env.SUSHI_PAIRS,
        config.sushiPairsProvider
      )
    );
  }

  // Stellar DEX — always available, uses Horizon (no contract needed)
  if (config.horizonUrl) {
    registry.register(new StellarDexAdapter(config.horizonUrl));
  }

  return registry;
}

// Interfaces must re-export as types — Node's native TS stripping (and any
// isolatedModules build) errors on value re-exports of type-only names.
export type { VenueAdapter, Quote, DepthQuote, SwapInstruction } from './adapter.js';
