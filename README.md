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

Deployed at block: 75174623n Address: 0x02e9dea502e9f7b7e805470ceb3baee58491930c
USDT deployed at: 0x02e9dea502e9f7b7e805470ceb3baee58491930c
Deployed at block: 75174634n Address: 0x19cd76a8f14a5f5c762043a7901a691dd6bc1be4
LP Token deployed at: 0x19cd76a8f14a5f5c762043a7901a691dd6bc1be4
Deployed at block: 75174647n Address: 0x24643e3f6adaa2500e9b7d9236519e8aaf63a2e9
PalindromeCryptoEscrow deployed at: 0x24643e3f6adaa2500e9b7d9236519e8aaf63a2e9 75174647n
LP minter set to escrow: 0x24643e3f6adaa2500e9b7d9236519e8aaf63a2e9