import { Address } from "viem";

/**
 * Default configuration for Palindrome Pay SDK
 */
export const CONFIG = {
  // TODO: Addresses below are the v1 deployments. Update both once the
  // Multisig v2 contracts (outcome-bound payout authorization) are deployed —
  // this SDK version (3.x) is NOT compatible with the v1 contracts.
  /** PalindromePay contract address (Base mainnet) */
  CONTRACT_ADDRESS: "0x47631c5Efe9AA709A020638B51E05b07e32FAF43" as Address,
  /** PalindromePay contract address (Base Sepolia testnet) */
  TESTNET_CONTRACT_ADDRESS: "0x2de68eec06080d7bc947c484aaff903e75bc08ea" as Address,
} as const;
