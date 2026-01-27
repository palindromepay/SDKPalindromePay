import { Address } from "viem";

/**
 * Default configuration for Palindrome Pay SDK
 */
export const CONFIG = {
  /**
   * Default PalindromePay contract address (Base mainnet)
   */
  DEFAULT_CONTRACT_ADDRESS: "0xb03432ef88795516e1a4f27bcbd46af971bbefb1" as Address,
} as const;
