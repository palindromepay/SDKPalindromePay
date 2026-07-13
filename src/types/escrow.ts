export interface Escrow {
  id: string;
  txUrl: string;
  buyer: string;
  seller: string;
  arbiter: string;
  token: string;
  wallet: string;
  amount: string;
  depositTime?: string;
  maturityTime?: string;
  /** Configured delivery window in seconds, re-anchored at deposit (Multisig v2) */
  maturityDuration?: string;
  state: string;
  title?: string;
  ipfsHash?: string;
  sellerWalletSig?: string;
  /** Terminal State (3=COMPLETE, 4=REFUNDED, 5=CANCELED) the seller signature authorizes */
  sellerWalletSigOutcome?: number;
  buyerWalletSig?: string;
  /** Terminal State (3=COMPLETE, 4=REFUNDED, 5=CANCELED) the buyer signature authorizes */
  buyerWalletSigOutcome?: number;
  arbiterWalletSig?: string;
  /** Terminal State (3=COMPLETE, 4=REFUNDED) the arbiter signature authorizes */
  arbiterWalletSigOutcome?: number;
  /** Arbiter fee in basis points, paid only when the arbiter resolves a dispute */
  arbiterFeeBps?: number;
  sellerAccepted: boolean;
  createdAt: string;
  updatedAt?: string;
  buyerCancelRequested?: boolean;
  sellerCancelRequested?: boolean;
  fee?: string;
  disputeStartTime?: string;
  disputeLongDeadline?: string;
  disputeStatus?: number;
  disputeMessages?: DisputeMessage[];
  events?: EscrowEvent[];
}

export interface EscrowEvent {
  id: string;
  type: string;
  sender?: string;
  amount?: string;
  fee?: string;
  state: string;
  timestamp: string;
  details?: string;
}

export interface DisputeMessage {
  id: string;
  role: string;
  roleValue: number;
  sender: string;
  ipfsHash: string;
  timestamp: string;
  txHash: string;
}
