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
  state: string;
  title?: string;
  ipfsHash?: string;
  sellerWalletSig?: string;
  buyerWalletSig?: string;
  arbiterWalletSig?: string;
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
