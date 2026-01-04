# PalindromeEscrowSDK

[![npm version](https://img.shields.io/npm/v/@palindromecryptoescrow/sdk.svg)](https://www.npmjs.com/package/@palindromecryptoescrow/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Documentation](https://img.shields.io/badge/docs-sdk.palindromefinance.com-blue)](https://sdk.palindromefinance.com)

A TypeScript/Node SDK for interacting with the PalindromeCryptoEscrow smart contract and subgraph, including signature flows, event utilities, token helpers, and robust error handling.

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
- Comprehensive state and role validation helpers (v1.9.3+)

---

## 📦 Installation

```bash
npm install @palindromecryptoescrow/sdk
```

## 🚀 Quick Start

```typescript
import { PalindromeEscrowSDK } from '@palindromecryptoescrow/sdk';
import { createPublicClient, createWalletClient, http } from 'viem';

// Create clients
const publicClient = createPublicClient({
  chain: yourChain,
  transport: http()
});

const walletClient = createWalletClient({
  chain: yourChain,
  transport: http(),
  account: yourAccount
});

// Initialize SDK
const sdk = new PalindromeEscrowSDK({
  publicClient,
  walletClient,
  contractAddress: '0x...',
  subgraphUrl: 'https://...'
});

// Create an escrow
const escrow = await sdk.createEscrow({
  token: '0x...', // ERC20 token address
  buyer: '0x...', // Buyer address
  amount: 1000000n, // Amount in smallest unit
  maturityDays: 7n, // 7 days until auto-release
  arbiter: '0x...', // Optional arbiter
  title: 'Purchase of Product X',
  ipfsHash: 'Qm...' // Optional IPFS metadata
});
```

---

## ⚠️ Token Compatibility

**CRITICAL: Not all ERC20 tokens are compatible with this escrow system.**

### ✅ Supported Tokens

The escrow contract works correctly with **standard ERC20 tokens** that:
- Transfer the exact amount specified (no fees on transfer)
- Have fixed supply (no rebasing)
- Cannot be paused by admin once deposited
- Do not have address blocklists

**Examples of Safe Tokens:**
- DAI
- WETH
- Standard ERC20 tokens without special features

### ❌ Unsupported Tokens

**1. Fee-on-Transfer Tokens**
- **What:** Tokens that deduct a fee during transfers
- **Why Unsafe:** Escrow will receive less than the deposit amount, breaking accounting
- **Examples:** SafeMoon, PAXG, some tax tokens
- **Risk Level:** 🔴 CRITICAL - Will cause fund loss

**2. Rebasing Tokens**
- **What:** Tokens whose balance changes automatically over time
- **Why Unsafe:** Escrow balance will change unexpectedly, breaking release amounts
- **Examples:** stETH, AMPL, OHM
- **Risk Level:** 🔴 CRITICAL - Unpredictable outcomes

**3. Pausable Tokens**
- **What:** Tokens that can be paused by admin, freezing all transfers
- **Why Unsafe:** Escrow may become permanently locked if token is paused
- **Examples:** USDC, USDT (admin can pause)
- **Risk Level:** 🟡 MEDIUM - Temporary freeze possible
- **Mitigation:** Only use with trusted token issuers

**4. Blocklist Tokens**
- **What:** Tokens where admin can blocklist specific addresses
- **Why Unsafe:** Escrow wallet could be blocklisted, freezing funds
- **Examples:** USDC, USDT (admin can blocklist)
- **Risk Level:** 🟡 MEDIUM - Funds could be frozen
- **Mitigation:** Only use with trusted token issuers

### 🔍 How to Check Token Compatibility

```typescript
// Use the SDK to verify token decimals and basic functionality
const decimals = await sdk.getTokenDecimals(tokenAddress);
const balance = await sdk.getTokenBalance(userAddress, tokenAddress);

// For production, additionally check:
// 1. Token contract source code for transfer fees
// 2. Token documentation for rebasing mechanics
// 3. Token admin capabilities (pause, blocklist)
```

**Best Practice:** Always test with small amounts first on mainnet or use testnet for new tokens.

---

## 🌐 Rate Limiting Best Practices

### RPC Provider Limits

The SDK makes multiple RPC calls for operations like:
- Creating escrows (3-5 calls)
- Fetching multiple nonces (1-20+ calls depending on count)
- Batch operations (N calls per item)

**Recommended RPC Providers & Limits:**

| Provider | Free Tier | Recommended Plan | Notes |
|----------|-----------|------------------|-------|
| Alchemy | 300M CU/month | Growth ($49/mo) | Best for production |
| Infura | 100k req/day | Developer ($50/mo) | Good reliability |
| QuickNode | 10M credits | Pro ($49/mo) | Low latency |

### SDK Rate Limiting Features

The SDK includes built-in optimizations:
- **Multicall support:** Batches multiple reads into one RPC call (when supported)
- **Caching:** Fee receiver, decimals, multicall support cached
- **Efficient nonce fetching:** Automatically uses multicall for bulk nonce queries

### Implementing Your Own Rate Limiting

```typescript
// Example: Rate limit with p-queue
import PQueue from 'p-queue';

const queue = new PQueue({
  concurrency: 5,  // Max 5 concurrent requests
  interval: 1000,  // Per second
  intervalCap: 10  // Max 10 requests per interval
});

// Wrap SDK calls
const escrow = await queue.add(() =>
  sdk.getEscrowByIdParsed(escrowId)
);
```

### Monitoring RPC Usage

```typescript
// Enable debug logging to monitor RPC calls
const sdk = new PalindromeEscrowSDK({
  // ... other config
  logger: customLogger, // Implement custom logger to track calls
  logLevel: 'debug'
});
```

**Production Tip:** Use a dedicated RPC endpoint with higher limits for user-facing applications.

---

## ⛽ Gas Estimation

The SDK provides gas estimation helpers to help users plan transaction costs:

### Estimating Gas for Operations

```typescript
// Estimate gas for creating an escrow
const gasEstimate = await sdk.estimateGasForCreateEscrow({
  token: tokenAddress,
  buyer: buyerAddress,
  amount: 1000000n,
  maturityDays: 7n,
  arbiter: arbiterAddress,
  title: 'Test Escrow',
  ipfsHash: ''
});

console.log(`Estimated gas: ${gasEstimate.gasLimit}`);
console.log(`Estimated cost: ${gasEstimate.estimatedCostWei} wei`);
console.log(`Estimated cost: ${gasEstimate.estimatedCostEth} ETH`);

// Estimate gas for deposit
const depositGas = await sdk.estimateGasForDeposit(escrowId);

// Estimate gas for confirm delivery
const confirmGas = await sdk.estimateGasForConfirmDelivery(escrowId);
```

### Gas Price Information

```typescript
// Get current gas prices
const gasPrice = await sdk.getCurrentGasPrice();
console.log(`Current gas price: ${gasPrice.standard} gwei`);
console.log(`Fast: ${gasPrice.fast} gwei`);
console.log(`Instant: ${gasPrice.instant} gwei`);
```

### Setting Custom Gas Limits

```typescript
const sdk = new PalindromeEscrowSDK({
  // ... other config
  defaultGasLimit: 500000n // Custom gas limit for all transactions
});
```

---

## 🛡️ Security Best Practices

1. **Always validate addresses** before creating escrows
2. **Use arbiter for high-value transactions**
3. **Set appropriate maturity times** (7-30 days recommended)
4. **Test with small amounts first**
5. **Verify token compatibility** before using (see Token Compatibility section)
6. **Monitor for pausable/blocklist tokens**

---

## 📚 API Reference

### Helper Methods (New in v1.9.3)

#### State Validation Helpers
```typescript
// Check if user can deposit
const canDeposit = await sdk.canUserDeposit(userAddress, escrowId);

// Check if user can accept escrow
const canAccept = await sdk.canUserAcceptEscrow(userAddress, escrowId);

// Check if user can confirm delivery
const canConfirm = await sdk.canUserConfirmDelivery(userAddress, escrowId);

// Check if user can start dispute
const canDispute = await sdk.canUserStartDispute(userAddress, escrowId);

// Check if escrow can be auto-released
const canWithdraw = await sdk.canUserWithdraw(escrowId);

// Check if seller can auto-release
const canAutoRelease = await sdk.canSellerAutoRelease(userAddress, escrowId);
```

#### Role Validation Helpers
```typescript
const escrow = await sdk.getEscrowByIdParsed(escrowId);

// Check roles
const isBuyer = sdk.isBuyer(userAddress, escrow);
const isSeller = sdk.isSeller(userAddress, escrow);
const isArbiter = sdk.isArbiter(userAddress, escrow);
const hasArbiter = sdk.hasArbiter(escrow);

// Compare addresses safely
const areEqual = sdk.addressEquals(address1, address2);
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
