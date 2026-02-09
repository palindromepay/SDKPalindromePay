import { Address } from "viem";

/**
 * Default configuration for Palindrome Pay SDK
 */
export const CONFIG = {
  /**
   * Default PalindromePay contract address (Base mainnet)
   */
  DEFAULT_CONTRACT_ADDRESS: "0x2de68eec06080d7bc947c484aaff903e75bc08ea" as Address,
} as const;
