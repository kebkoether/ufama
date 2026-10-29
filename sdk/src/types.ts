/** Wire types for the ufama API. Amounts are base-unit strings. */

export interface Token {
  symbol: string;
  name: string;
  contract: string;
  issuer: string | null;
  decimals: number;
  verified: boolean;
  venueVolume: number;
}

export interface Asset {
  symbol: string;
  name: string;
  sacAddress: string;
  issuer?: string;
  decimals: number;
  status: 'live' | 'coming_soon';
  verified?: boolean;
  venueVolume?: number;
  twapEligible?: boolean;
}

export interface RouteSegment {
  venue: string;
  amountIn: string;
  expectedOut: string;
}

export interface IntegratorQuote {
  assetIn: string;
  assetOut: string;
  amountIn: string;
  amountOut: string;
  partnerFee: string;
  partnerFeeCollected: boolean;
  minAmountOut: string;
  kind: 'classic' | 'soroban';
  priceImpactBps?: number;
  priceImpactWarning?: boolean;
  priceImpactBlocked?: boolean;
  segments: RouteSegment[];
}

export interface IntegratorBuild {
  xdr: string;
  kind: 'classic' | 'soroban';
  partnerFee: string;
  partnerFeeCollected: boolean;
  expectedOut: string;
}

export interface SendResult {
  status: string;
  hash?: string;
  result?: unknown;
}

// ─── RFQ ────────────────────────────────────────────────

export interface RfqReference {
  navAmountOut: string | null;
  navPrice: number | null;
  navSource: string | null;
  navAgeSec: number | null;
  oracleOnChain: boolean;
  issuerNavAmountOut: string | null;
  issuerNavSource: string | null;
  issuerNavAgeSec: number | null;
  issuerVsOracleBps: number | null;
  ammAmountOut: string | null;
  ammVsNavBps: number | null;
  ammVenues: string[];
  bookAmountOut: string | null;
  bookAmountInUsed: string | null;
  bookVsNavBps: number | null;
  bookFills: number;
}

export type RfqPreview = RfqReference & {
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
};

export type RfqRequestStatus = 'open' | 'accepted' | 'settled' | 'expired' | 'cancelled';
export type RfqQuoteStatus = 'live' | 'accepted' | 'superseded' | 'expired' | 'rejected';

export interface RfqQuote {
  id: string;
  requestId: string;
  maker: string;
  makerLabel: string;
  amountOut: string;
  expiryLedger: number;
  expiresAt: number;
  nonce: string;
  maxNavDevBps: number;
  /** Signed bps vs the oracle NAV: positive = taker receives less. */
  vsNavBps: number | null;
  status: RfqQuoteStatus;
  receivedAt: number;
}

export interface RfqRequest {
  id: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  amountIn: string;
  createdAt: number;
  expiresAt: number;
  ledgerAtCreate: number;
  status: RfqRequestStatus;
  reference: RfqReference;
  quotes: RfqQuote[];
  acceptedQuoteId: string | null;
  settledHash: string | null;
}

export interface RfqQuoteFields {
  maker: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  amountOut: string;
  expiryLedger: number;
  nonce: string;
  maxNavDevBps: number;
}

export interface RfqPrepareResponse {
  quote: RfqQuoteFields;
  /** Unsigned SorobanAuthorizationEntry, base64 XDR. Sign it with the maker key. */
  authEntryXdr: string;
  check: {
    fee: string;
    makerReceives: string;
    fairOut: string | null;
    vsNavBps: number | null;
  };
}

export type RfqEvent =
  | { type: 'hello'; maker: string; open: RfqRequest[] }
  | { type: 'request.created'; request: RfqRequest }
  | { type: 'request.closed'; requestId: string; status: RfqRequestStatus };

export class UfamaApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public path: string
  ) {
    super(message);
    this.name = 'UfamaApiError';
  }
}
