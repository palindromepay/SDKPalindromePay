export interface Escrow {
  id: string;
  txUrl: string;
  buyer: string;
  seller: string;
  arbiter: string;
  token: string;
  amount: string;
  depositTime?: string;
  maturityTime?: string;
  state: string;
  title?: string;
  ipfsHash?: string;
  createdAt: string;
  updatedAt?: string;
  buyerCancelRequested?: boolean;
  sellerCancelRequested?: boolean;
  events?: EscrowEvent[];
}

export interface EscrowEvent {
  id: string;
  type: string;
  sender: string;
  amount?: string;
  state?: string;
  timestamp: string;
  details?: string;
}
