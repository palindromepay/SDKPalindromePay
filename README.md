# PalindromePay SDK

[![npm version](https://img.shields.io/npm/v/@palindromepay/sdk.svg)](https://www.npmjs.com/package/@palindromepay/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-sdk.palindromefinance.com-blue)](https://sdk.palindromefinance.com)

A TypeScript/Node SDK for interacting with the PalindromePay escrow smart contract and subgraph, including signature flows, event utilities, token helpers, and robust error handling.

---

## 📚 Documentation

**Full documentation available at: [sdk.palindromefinance.com](https://sdk.palindromefinance.com)**

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

- GitHub Issues: https://github.com/palindrome-finance/escrow-sdk/issues
- Documentation: https://github.com/palindrome-finance/escrow-sdk#readme
