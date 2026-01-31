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
