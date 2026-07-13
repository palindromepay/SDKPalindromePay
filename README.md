# PalindromePay SDK

[![npm version](https://img.shields.io/npm/v/@palindromepay/sdk.svg)](https://www.npmjs.com/package/@palindromepay/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-sdk.palindromepay.com-blue)](https://sdk.palindromepay.com)

A TypeScript/Node SDK for interacting with the PalindromePay escrow smart contract and subgraph, including signature flows, event utilities, token helpers, and robust error handling.

---

## 📚 Documentation

**Full documentation available at: [palindromepay.com/sdk](https://www.palindromepay.com/sdk)**

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
- Gas estimation helpers for transaction planning
- Comprehensive state and role validation helpers

---

## ⚠️ v3.0.0 — Outcome-Bound Payout Authorization (Multisig v2)

SDK v3 targets the Multisig v2 contracts and is **not compatible with v1 deployments**.
A participant's signature now authorizes one specific payout outcome instead of being a
blanket participation token (`COMPLETE = 3`, `REFUNDED = 4`, `CANCELED = 5`):

| Action | Signer | Outcome signed |
|---|---|---|
| `createEscrow` / `createEscrowAndDeposit` / `deposit` / `acceptEscrow` / `confirmDelivery` | seller / buyer | `COMPLETE` (3) |
| `requestCancel` | buyer or seller | `CANCELED` (5) |
| `submitArbiterDecision` | arbiter | the ruling: `COMPLETE` (3) or `REFUNDED` (4) |
| `refundAfterDisputeTimeout` | buyer | `REFUNDED` (4) |
| `autoRelease` / `cancelByTimeout` | — | reuses the stored signature |

Breaking API changes:

- `signWalletAuthorization(walletClient, wallet, escrowId, outcome)` signs the new
  `PayoutAuthorization` EIP-712 type (extra `uint8 outcome` field).
- `getWalletSignatureCount(escrowId, outcome)` counts signatures per outcome.
- The escrow EIP-712 domain name changed to `"PalindromePay"`.
- `CreateEscrowParams`/`CreateEscrowAndDepositParams` accept `arbiterFeeBps`
  (0–2000 bps, paid only when the arbiter resolves a dispute).
- `EscrowData` gained `maturityDuration` and `arbiterFeeBps`.

New methods:

- `refundAfterDisputeTimeout(walletClient, escrowId)` — buyer refund after the arbiter
  missed the 30-day dispute deadline (+1h buffer).
- `signSetArbiter(...)` + `setArbiterSigned(walletClient, params)` — assign an arbiter to an
  arbiterless escrow with mutual buyer+seller consent (shared nonce, deadline ≤ 1 day).

`deposit` now fails fast with "Escrow expired" when the maturity time has passed
(the contract re-anchors the maturity window at deposit time).

---

## 🚀 Getting Started

Palindrome Pay is an open-source SDK for building escrow functionality into decentralized applications using smart contracts.

**Non-custodial**: All funds are held in smart contracts on the blockchain - Palindrome Pay never has access to or control over user funds. Transactions are peer-to-peer between buyer and seller.

---

## 📦 Installation

```bash
npm install @palindromepay/sdk
```

---

## 🧪 Testing

```bash
# Run all tests
npm test

# Run core functionality tests only
npm run test:core

# Run security tests only
npm run test:security
```

---

## 📝 Development

```bash
# Install dependencies
npm install

# Build the project
npm run build

# Clean build artifacts
npm run clean
```

---

## 📄 License

MIT License - see LICENSE file for details

---

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## 📞 Support

- GitHub Issues: https://github.com/palindromepay/SDKPalindromePay/issues
- Documentation: https://www.palindromepay.com/sdk
