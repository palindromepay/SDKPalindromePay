import { Address } from "viem";

/**
 * Default configuration for Palindrome Pay SDK
 */
export const CONFIG = {
  /** PalindromePay contract address (Base mainnet) */
  CONTRACT_ADDRESS: "0x47631c5Efe9AA709A020638B51E05b07e32FAF43" as Address,
  /** PalindromePay contract address (Base Sepolia testnet) */
  TESTNET_CONTRACT_ADDRESS: "0x2de68eec06080d7bc947c484aaff903e75bc08ea" as Address,
} as const;
