import { gql } from "@apollo/client/core";

/**
 * ESCROW QUERIES
 */
// Get all escrows (with dispute info)
export const ALL_ESCROWS_QUERY = gql`
  query AllEscrows {
    escrows {
      id
      txUrl
      token
      buyer
      seller
      arbiter
      wallet
      amount
      maturityTime
      maturityDuration
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get escrows by buyer (with dispute info)
export const ESCROWS_BY_BUYER_QUERY = gql`
  query EscrowsByBuyer($buyer: Bytes!) {
    escrows(where: { buyer: $buyer }) {
      id
      txUrl
      token
      arbiter
      buyer
      seller
      wallet
      amount
      maturityTime
      maturityDuration
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get escrows by seller (with dispute info)
export const ESCROWS_BY_SELLER_QUERY = gql`
  query EscrowsBySeller($seller: Bytes!) {
    escrows(where: { seller: $seller }) {
      id
      txUrl
      token
      arbiter
      buyer
      seller
      wallet
      amount
      maturityTime
      maturityDuration
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Detail for one escrow (with full dispute info)
export const ESCROW_DETAIL_QUERY = gql`
  query EscrowDetail($id: ID!) {
    escrow(id: $id) {
      id
      txUrl
      token
      buyer
      seller
      arbiter
      wallet
      amount
      maturityTime
      maturityDuration
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;


/**
 * DISPUTE QUERIES
 */
// Get all dispute messages for a specific escrow
export const DISPUTE_MESSAGES_BY_ESCROW_QUERY = gql`
  query DisputeMessagesByEscrow($escrowId: ID!) {
    escrow(id: $escrowId) {
      id
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;


// Get all disputed escrows with their messages
export const ALL_DISPUTED_ESCROWS_QUERY = gql`
  query AllDisputedEscrows {
    escrows(where: { state: "DISPUTED" }) {
      id
      txUrl
      token
      arbiter
      buyer
      seller
      wallet
      amount
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get escrow with full dispute details
export const ESCROW_WITH_DISPUTE_DETAILS_QUERY = gql`
  query EscrowWithDisputeDetails($escrowId: ID!) {
    escrow(id: $escrowId) {
      id
      txUrl
      token
      arbiter
      buyer
      seller
      wallet
      amount
      depositTime
      state
      title
      ipfsHash
      sellerWalletSig
      sellerWalletSigOutcome
      buyerWalletSig
      buyerWalletSigOutcome
      arbiterWalletSig
      arbiterWalletSigOutcome
      sellerAccepted
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get disputed escrows by buyer
export const DISPUTED_ESCROWS_BY_BUYER_QUERY = gql`
  query DisputedEscrowsByBuyer($buyer: Bytes!) {
    escrows(where: { buyer: $buyer, state: "DISPUTED" }) {
      id
      txUrl
      seller
      arbiter
      wallet
      amount
      title
      ipfsHash
      createdAt
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

export const DISPUTED_ESCROWS_BY_SELLER_QUERY = gql`
  query DisputedEscrowsBySeller($seller: Bytes!) {
    escrows(where: { seller: $seller, state: "DISPUTED" }) {
      id
      txUrl
      buyer
      arbiter
      wallet
      amount
      title
      ipfsHash
      createdAt
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get escrows pending arbiter review (in dispute, not all messages submitted)
export const ESCROWS_PENDING_ARBITER_REVIEW_QUERY = gql`
  query EscrowsPendingArbiterReview($arbiter: Bytes!) {
    escrows(where: { arbiter: $arbiter, state: "DISPUTED" }) {
      id
      txUrl
      buyer
      seller
      wallet
      amount
      title
      ipfsHash
      createdAt
      fee
      arbiterFeeBps
      disputeStartTime
      disputeLongDeadline
      disputeStatus
      disputeMessages {
        id
        role
        roleValue
        sender
        ipfsHash
        timestamp
        txHash
      }
    }
  }
`;

// Get all dispute messages by role
export const DISPUTE_MESSAGES_BY_ROLE_QUERY = gql`
  query DisputeMessagesByRole($escrowId: ID!, $role: String!) {
    disputeMessages(where: { escrow: $escrowId, role: $role }) {
      id
      role
      roleValue
      sender
      ipfsHash
      timestamp
      txHash
    }
  }
`;

// Get recent dispute activity (last 10)
export const RECENT_DISPUTE_ACTIVITY_QUERY = gql`
  query RecentDisputeActivity {
    disputeMessages(
      first: 10
      orderBy: timestamp
      orderDirection: desc
    ) {
      id
      escrow {
        id
        buyer
        seller
        amount
        title
      }
      role
      roleValue
      sender
      ipfsHash
      timestamp
      txHash
    }
  }
`;

// Check if specific address has submitted evidence for escrow
export const HAS_SUBMITTED_EVIDENCE_QUERY = gql`
  query HasSubmittedEvidence($escrowId: ID!, $sender: Bytes!) {
    disputeMessages(where: { escrow: $escrowId, sender: $sender }) {
      id
      role
      roleValue
      timestamp
      txHash
    }
  }
`;

// Get dispute submission status (check bits)
export const DISPUTE_SUBMISSION_STATUS_QUERY = gql`
  query DisputeSubmissionStatus($escrowId: ID!) {
    escrow(id: $escrowId) {
      id
      disputeStatus
      disputeStartTime
      disputeLongDeadline
      disputeMessages {
        id
        role
        roleValue
        sender
        timestamp
      }
    }
  }
`;

// Dispute status snapshot for a disputed escrow.
// NOTE: the v2 subgraph schema no longer has an `events` entity on Escrow —
// per-event history was dropped in the Multisig v2 migration.
export const DISPUTED_ESCROW_EVENTS_QUERY = gql`
  query DisputedEscrowEvents($escrowId: ID!) {
    escrow(id: $escrowId) {
      id
      state
      disputeStatus
      disputeStartTime
      disputeLongDeadline
    }
  }
`;
