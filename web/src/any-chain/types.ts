export interface OriginToken {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  price: number;
  contractAddress?: string;
}

export interface PayQuote {
  amountIn: string;
  amountInUsd: string;
  amountOut: string;
  amountOutUsd: string;
  minAmountOut: string;
  refundFee: string;
  withdrawFee: string;
  timeEstimate: number;
  depositAddress?: string;
  depositMemo?: string;
  deadline?: string;
  timeWhenInactive?: string;
}

export interface QuoteAnswer {
  id: string;
  quote: PayQuote;
  signature: string;
  providerReference: string;
  refundTo?: string;
  /** HTTP Date from the Worker response; used with a monotonic elapsed clock for expiry. */
  serverTime?: string;
}

export interface QuoteInput {
  tokenId: string;
  originAsset: string;
  amount: string;
  refundTo: string;
}

export interface AddressAnswer {
  tokenId: string;
  addresses: Array<{ chain: 'base' | 'solana'; address: string; asset: string; contractAddress: string;
    amountUsdc: string; waitSeconds: number; path: string }>;
  minimumFoodYocto: string;
}

export interface TrackedDeposit {
  id: string;
  url: string;
  status: { state: 'waiting_for_owner' | 'converting' | 'became_food' | 'refunded';
    source: string; nearCredit: string | null; refund: string | null };
}

export interface QuoteStatus {
  id: string; tokenId: string; state: string; providerState: string | null;
  sourceAmount?: string; sourceAsset?: string; sourceChain?: string | null; sourceDecimals?: number;
  providerStatusUrl?: string | null;
  providerReference: string | null; sourceTxHash: string | null; sourceCondition: string | null;
  /** A coded contract rejection or recovery outcome the status screen words (`reasonLine`); absent for an ordinary route. */
  reason?: string | null;
  providerRefundAmount: string | null; providerRefundTxHash: string | null; refundTo: string;
  deliveries: Array<{ receiptId: string; nearTxHash: string; amount: string; kind: string;
    creditId: number | null; heldId: number | null; reason: string | null;
    unwrapFailed: boolean; creditedAmount: string | null }>;
}

export interface DepositStatus {
  id: string; tokenId: string; state: 'waiting_for_owner' | 'converting' | 'became_food' | 'refunded';
  source: string; nearCredit: string | null; refund: string | null;
  settledUnits?: string; remainingUnits?: string;
}

export interface OwnerDeposit {
  id: string; token_id: string; chain: 'base' | 'solana'; source_tx_hash: string;
  asset: 'usdc' | 'other'; amount_units: string;
  state: 'waiting' | 'below_minimum' | 'unsupported' | 'converting' | 'food' | 'refunded';
  address: string; source_explorer: string; near_credit_tx: string | null;
  source_refund_tx: string | null;
}
export interface OwnerQuoteCredit { id: string; creditId: number; wasAsleep: boolean; route: 'quote' | 'pet_address' }
export interface SweepQuote {
  routeId: string; amountUnits: string; remainderUnits: string; chain: 'base' | 'solana';
  destination: string; refundTo: string; quote: PayQuote; approvalHash: string; expiryMs: number;
}
export interface SweepRead {
  routeId: string; amountUnits: string; destination: string; refundTo: string;
  /** `correlationId` is 1-Click's reference for this conversion; the Worker stores the whole answer with the sweep. */
  quote: { quote: PayQuote; correlationId?: string }; approvalHash: string; expiryMs: number; state: string;
  nearTxHash: string | null; sourceTxHash: string | null; windowEndsAt: number;
}
export interface OwnerDepositRead { deposit: OwnerDeposit; convertedUnits: string; sweep: SweepRead | null }
export interface SweepOutcome { state: string; nearTxHash: string | null; sourceTxHash?: string | null; routeId?: string }

export interface HeldStatus {
  heldId: number; amount: string; reason: string; nearTxHash: string; state: string;
  sourceVerified: boolean; recipient?: string | null; sourceTxHash?: string | null;
  quote?: { amountOut: string; minAmountOut: string; refundFee: string; withdrawFee: string } | null;
  providerReference?: string | null; releaseTxHash: string | null; refundTxHash: string | null;
  refundAmountUsdc: string | null;
  /** The return is made in the asset the payer sent: its amount, symbol and decimals (USDC returns carry the same in `refundAmountUsdc`). */
  refundAmount?: string | null; refundAsset?: string | null; refundDecimals?: number | null;
}
