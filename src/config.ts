import { Address } from "viem";

/**
 * Default configuration for Palindrome Pay SDK
 */
export const CONFIG = {
  // TODO: Mainnet address is still the v1 deployment. Update after the
  // Multisig v2 mainnet deploy (via Trezor/Frame) — SDK 3.x is NOT
  // compatible with the v1 contracts.
  /** PalindromePay contract address (Base mainnet) */
  CONTRACT_ADDRESS: "0x47631c5Efe9AA709A020638B51E05b07e32FAF43" as Address,
  /** PalindromePay v2 contract address (Base Sepolia testnet, deployed at block 44472870) */
  TESTNET_CONTRACT_ADDRESS: "0x284f3cfecf64efb47a13bf7daca1aadea646f885" as Address,
} as const;
