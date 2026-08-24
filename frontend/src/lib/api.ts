/**
 * Backend API client for Ufama (formerly AtomicSwap Aggregator).
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface Asset {
  symbol: string;
  name: string;
  issuer: string;
  decimals: number;
  status: 'live' | 'coming_soon';
  /** SAC contract address (empty until configured/discovered) */
  sacAddress?: string;
  /** 'curated' (registry) or a venue name like 'aqua' */
  source?: string;
  /** Curated entries are verified; venue-discovered ones are not */
  verified?: boolean;
}

export interface RouteSegment {
  venue: string;
  venueId: number;
  amountIn: string;
  expectedOut: string;
  effectiveBps: number;
}

export interface SwapInstruction {
  venueContractId: string;
  venueId: number;
  amountIn: string;
  minAmountOut: string;
}

export interface QuoteResponse {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  netAmountOut: string;
  protocolFee: string;
  blendedBps: number;
  segments: RouteSegment[];
  instructions: SwapInstruction[];
}

export async function getQuote(
  tokenIn: string,
  tokenOut: string,
  amountIn: string,
  slippage?: number
): Promise<QuoteResponse> {
  const params = new URLSearchParams({
    tokenIn,
    tokenOut,
    amountIn,
    ...(slippage && { slippage: slippage.toString() }),
  });

  const response = await fetch(`${API_BASE}/api/quote?${params}`);
  if (!response.ok) {
    // Surface the server's reason (e.g. no venue liquidity) to the UI
    let detail = response.statusText;
    try {
      const body = await response.json();
      if (body?.error) detail = body.error;
    } catch {}
    throw new Error(detail);
  }
  return response.json();
}

export async function getAssets(): Promise<Asset[]> {
  const response = await fetch(`${API_BASE}/api/assets`);
  if (!response.ok) {
    throw new Error(`Assets fetch failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.assets;
}

/** Full assets payload: token list + server-side config (P2P corridor). */
export async function getAssetsFull(): Promise<{
  assets: Asset[];
  p2pAllowed: string[];
}> {
  const response = await fetch(`${API_BASE}/api/assets`);
  if (!response.ok) {
    throw new Error(`Assets fetch failed: ${response.statusText}`);
  }
  return response.json();
}

export async function getOrders(
  tokenIn: string,
  tokenOut: string
): Promise<any[]> {
  const params = new URLSearchParams({ tokenIn, tokenOut });
  const response = await fetch(`${API_BASE}/api/orders?${params}`);
  if (!response.ok) {
    throw new Error(`Orders fetch failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.orders;
}

export async function getUserOrders(address: string): Promise<any[]> {
  const response = await fetch(`${API_BASE}/api/orders/user/${address}`);
  if (!response.ok) {
    throw new Error(`User orders fetch failed: ${response.statusText}`);
  }
  const data = await response.json();
  return data.orders;
}

export async function getTwapFee(): Promise<{ feeBps: number; maxFeeBps: number } | null> {
  try {
    const response = await fetch(`${API_BASE}/api/twap/fee`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function getOraclePrice(
  tokenIn: string,
  tokenOut: string
): Promise<{ available: boolean; price?: number; fetchedAt?: string }> {
  const params = new URLSearchParams({ tokenIn, tokenOut });
  const response = await fetch(`${API_BASE}/api/oracle/price?${params}`);
  if (!response.ok) {
    return { available: false };
  }
  return response.json();
}

export async function buildPeerSwap(body: {
  sourceAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  minAmountOut: string;
  expiry?: number;
  priceMode?: number;
  maxSlippageBps?: number;
  autoRouteMinutes?: number;
}): Promise<any> {
  const response = await fetch(`${API_BASE}/api/peer-swap/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Peer swap build failed: ${response.statusText}`);
  }
  return response.json();
}

export async function buildCancelOrder(
  sourceAddress: string,
  orderId: number
): Promise<{ xdr: string }> {
  const response = await fetch(`${API_BASE}/api/orders/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceAddress, orderId }),
  });
  if (!response.ok) {
    throw new Error(`Cancel build failed: ${response.statusText}`);
  }
  return response.json();
}

export async function buildSwap(body: {
  sourceAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  slippage?: number;
}): Promise<{
  /** Present for single-transaction plans (kind 'soroban' | 'classic') */
  xdr?: string;
  kind: 'soroban' | 'classic' | 'blend';
  /** Present for kind 'blend': sign and submit each leg in order */
  legs?: Array<{ kind: 'soroban' | 'classic'; xdr: string; amountIn: string; expectedOut: string }>;
  route: any;
}> {
  const response = await fetch(`${API_BASE}/api/swap/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Swap build failed: ${response.statusText}`);
  }
  return response.json();
}

// ─── TWAP ────────────────────────────────────────────────

export async function buildTwap(body: {
  sourceAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  durationMinutes: number;
  limitPrice?: string;
  maxSlippageBps?: number;
  maxSlicePct?: number;
  minSliceGapSeconds?: number;
}): Promise<{ xdr: string; plan: any }> {
  const response = await fetch(`${API_BASE}/api/twap/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `TWAP build failed: ${response.statusText}`);
  }
  return response.json();
}

export async function getTwapOrders(maker?: string): Promise<any[]> {
  const params = maker ? `?maker=${encodeURIComponent(maker)}` : '';
  const response = await fetch(`${API_BASE}/api/twap/orders${params}`);
  if (!response.ok) throw new Error(`TWAP orders fetch failed: ${response.statusText}`);
  const data = await response.json();
  return data.orders;
}

export async function buildTwapCancel(
  sourceAddress: string,
  orderId: number
): Promise<{ xdr: string }> {
  const response = await fetch(`${API_BASE}/api/twap/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sourceAddress, orderId }),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || `Cancel build failed: ${response.statusText}`);
  }
  return response.json();
}

export async function submitTransaction(
  signedXdr: string
): Promise<{ status: string; result: any }> {
  const response = await fetch(`${API_BASE}/api/swap/submit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signedXdr }),
  });
  if (!response.ok) {
    throw new Error(`Submit failed: ${response.statusText}`);
  }
  return response.json();
}

export async function getHealth(): Promise<{
  status: string;
  venues: string[];
  network: string;
}> {
  const response = await fetch(`${API_BASE}/api/health`);
  return response.json();
}

export { API_BASE };
