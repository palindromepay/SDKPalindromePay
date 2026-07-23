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
  /** PalindromePay v2 contract address (Base Sepolia testnet, block 44533995, EIP-7702 arbiters allowed) */
  TESTNET_CONTRACT_ADDRESS: "0x84786faacb03eb2972c691af6c7ec78d0d75b439" as Address,
} as const;
