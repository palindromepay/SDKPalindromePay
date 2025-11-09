# PalindromeEscrowSDK

A TypeScript/Node SDK for interacting with the PalindromeCryptoEscrow smart contract and subgraph, including signature flows, event utilities, token helpers, and robust error handling.

---

## ✨ Features

- Interact with on-chain escrow contracts using public & wallet clients
- Supports ERC20 deposits, fee calculation, and contract state queries
- Buyer, Seller, Arbiter roles—plus dispute/resolve logic
- Meta-transaction signature helpers (EIP-712 compatible)
- Auto-release and time/maturity helpers
- Subgraph GraphQL queries to fetch and filter escrows and dispute messages
- Flexible error classes and codes for wallet/client state
- Utilities for fee calculation, token formatting, deadlines, and maturity times

---

### 1. Install dependencies: 
npm install

### 2. Test: 
ts-node tests/test.ts

For more informaiton about the SDK please check the SDK documentation (in progress)