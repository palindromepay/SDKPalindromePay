// Copyright (c) 2025 Palindrome Pay
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PALINDROME Pay SDK
 * 
 * Key contract functions:
 * - createEscrow(token, buyer, amount, maturityDays, arbiter, title, ipfsHash, sellerWalletSig)
 * - createEscrowAndDeposit(token, seller, amount, maturityDays, arbiter, title, ipfsHash, buyerWalletSig)
 * - deposit(escrowId, buyerWalletSig)
 * - acceptEscrow(escrowId, sellerWalletSig)
 * - confirmDelivery(escrowId, buyerWalletSig)
 * - confirmDeliverySigned(escrowId, coordSignature, deadline, nonce, buyerWalletSig)
 * - requestCancel(escrowId, walletSig)
 * - cancelByTimeout(escrowId)
 * - autoRelease(escrowId)
 * - startDispute(escrowId)
 * - startDisputeSigned(escrowId, signature, deadline, nonce)
 * - submitDisputeMessage(escrowId, role, ipfsHash)
 * - submitArbiterDecision(escrowId, resolution, ipfsHash, arbiterWalletSig)
 * - Wallet: withdraw()
 */

import {
  Address,
  Abi,
  PublicClient,
  WalletClient,
  Hex,
  encodeFunctionData,
  parseEventLogs,
  Transport,
  Account,
  Chain,
  pad,
  getAddress,
  zeroAddress,
  TransactionReceipt,
  verifyTypedData,
} from "viem";
import { readContract, multicall } from "viem/actions";
import PalindromePayABI from "./contract/PalindromePay.json";
import PalindromePayWalletABI from "./contract/PalindromePayWallet.json";
import ERC20ABI from "./contract/USDT.json";
import { ApolloClient } from "@apollo/client";
import { CONFIG } from "./config";

// ==========================================================================
// ERROR TYPES
// ==========================================================================

export type ViemError = {
  message: string;
  shortMessage?: string;
  cause?: {
    reason?: string;
    message?: string;
  };
  code?: number;
  stack?: string;
};

export type ContractError = ViemError & {
  contractAddress?: Address;
  functionName?: string;
  args?: readonly unknown[];
};

export type RPCError = {
  message: string;
  code?: number;
  data?: unknown;
};

export type UnknownError = {
  message?: string;
  toString(): string;
};

/** Type guard to check if error is a Viem error */
function isViemError(error: unknown): error is ViemError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as Record<string, unknown>).message === 'string'
  );
}

/** Type guard to check if error is a contract error */
function isContractError(error: unknown): error is ContractError {
  return isViemError(error) && 'contractAddress' in error;
}

/** Type guard to check if error has a short message */
function hasShortMessage(error: unknown): error is ViemError & { shortMessage: string } {
  return (
    isViemError(error) &&
    'shortMessage' in error &&
    typeof (error as Record<string, unknown>).shortMessage === 'string'
  );
}

// ==========================================================================
// LOGGER TYPES
// ==========================================================================

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'none';

export interface SDKLogger {
  debug(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

/** Default console logger */
const defaultLogger: SDKLogger = {
  debug: (msg, ctx) => ctx !== undefined ? console.debug(msg, ctx) : console.debug(msg),
  info: (msg, ctx) => ctx !== undefined ? console.info(msg, ctx) : console.info(msg),
  warn: (msg, ctx) => ctx !== undefined ? console.warn(msg, ctx) : console.warn(msg),
  error: (msg, ctx) => ctx !== undefined ? console.error(msg, ctx) : console.error(msg),
};

/** No-op logger (disables all logging) */
const noOpLogger: SDKLogger = {
  debug: () => { },
  info: () => { },
  warn: () => { },
  error: () => { },
};

// ==========================================================================
// IMPORTS CONTINUED
// ==========================================================================

import {
  ALL_ESCROWS_QUERY,
  DISPUTE_MESSAGES_BY_ESCROW_QUERY,
  ESCROWS_BY_BUYER_QUERY,
  ESCROWS_BY_SELLER_QUERY,
  ESCROW_DETAIL_QUERY,
} from "./subgraph/queries";
import { Escrow, DisputeMessage } from "./types/escrow";
import { hardhat } from "viem/chains";

// ============================================================================
// ENUMS & TYPES
// ============================================================================

export enum EscrowState {
  AWAITING_PAYMENT = 0,
  AWAITING_DELIVERY = 1,
  DISPUTED = 2,
  COMPLETE = 3,
  REFUNDED = 4,
  CANCELED = 5,
}

export enum DisputeResolution {
  Complete = 3,
  Refunded = 4,
}

export enum Role {
  None = 0,
  Buyer = 1,
  Seller = 2,
  Arbiter = 3,
}

// ==========================================================================
// CONSTANTS
// ==========================================================================

/** Maximum length for string fields (title, IPFS hash) */
const MAX_STRING_LENGTH = 500;

/** User rejection error code from wallet */
const USER_REJECTION_CODE = 4001;

/** Seconds per day for maturity calculations */
const SECONDS_PER_DAY = 86400n;

/** Maximum maturity days (10 years) */
const MAX_MATURITY_DAYS = 3650n;

/** Nonce bitmap word size in bits */
const NONCE_BITMAP_SIZE = 256;

/** Default cache TTL in milliseconds */
const DEFAULT_CACHE_TTL = 5000;

/** Default transaction receipt timeout in milliseconds */
const DEFAULT_RECEIPT_TIMEOUT = 60000;

/** Default polling interval in milliseconds */
const DEFAULT_POLLING_INTERVAL = 5000;

// ==========================================================================
// ERROR CODES
// ==========================================================================

export enum SDKErrorCode {
  WALLET_NOT_CONNECTED = "WALLET_NOT_CONNECTED",
  WALLET_ACCOUNT_MISSING = "WALLET_ACCOUNT_MISSING",
  NOT_BUYER = "NOT_BUYER",
  NOT_SELLER = "NOT_SELLER",
  NOT_ARBITER = "NOT_ARBITER",
  INVALID_STATE = "INVALID_STATE",
  INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
  ALLOWANCE_FAILED = "ALLOWANCE_FAILED",
  SIGNATURE_EXPIRED = "SIGNATURE_EXPIRED",
  TRANSACTION_FAILED = "TRANSACTION_FAILED",
  INVALID_ROLE = "INVALID_ROLE",
  INVALID_TOKEN = "INVALID_TOKEN",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  RPC_ERROR = "RPC_ERROR",
  EVIDENCE_ALREADY_SUBMITTED = "EVIDENCE_ALREADY_SUBMITTED",
  ESCROW_NOT_FOUND = "ESCROW_NOT_FOUND",
  ALREADY_ACCEPTED = "ALREADY_ACCEPTED",
  SIGNATURE_INVALID = "SIGNATURE_INVALID",
}

export type EscrowWalletClient = WalletClient<Transport, Chain, Account>;

export class SDKError extends Error {
  code: SDKErrorCode;
  details?: ViemError | RPCError | UnknownError | Record<string, unknown>;

  constructor(
    message: string,
    code: SDKErrorCode,
    details?: ViemError | RPCError | UnknownError | Record<string, unknown>
  ) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "SDKError";
  }
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface PalindromePaySDKConfig {
  publicClient: PublicClient;
  /** Contract address (defaults to Palindrome Pay on Base mainnet) */
  contractAddress?: Address;
  walletClient?: EscrowWalletClient;
  /** Apollo client for subgraph queries (required) */
  apolloClient: ApolloClient;
  chain?: Chain;
  /** Cache TTL in milliseconds (default: 5000) */
  cacheTTL?: number;
  /** Maximum cache entries before LRU eviction (default: 1000) */
  maxCacheSize?: number;
  /** Enable automatic retry on RPC failures (default: true) */
  enableRetry?: boolean;
  /** Maximum retry attempts (default: 3) */
  maxRetries?: number;
  /** Retry delay in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Gas buffer percentage (default: 20) */
  gasBuffer?: number;
  /** Transaction receipt timeout in milliseconds (default: 60000) */
  receiptTimeout?: number;
  /**
   * Skip eth_call simulation before sending transactions (default: false)
   * Enable this for chains with unreliable RPC simulation (e.g., Base Sepolia)
   * When true, transactions are sent directly without pre-flight simulation
   */
  skipSimulation?: boolean;
  /**
   * Default gas limit when simulation is skipped (default: 500000n)
   * Only used when skipSimulation is true
   */
  defaultGasLimit?: bigint;
  /**
   * Logger instance for SDK events and errors (default: console)
   * Set to custom logger or use noOpLogger to disable
   */
  logger?: SDKLogger;
  /**
   * Minimum log level to output (default: 'info')
   * 'debug' shows all logs, 'none' disables all logging
   */
  logLevel?: LogLevel;
}

export interface CreateEscrowParams {
  token: Address;
  buyer: Address;
  amount: bigint;
  maturityTimeDays?: bigint;
  arbiter?: Address;
  title: string;
  ipfsHash?: string;
}

export interface CreateEscrowAndDepositParams {
  token: Address;
  seller: Address;
  amount: bigint;
  maturityTimeDays?: bigint;
  arbiter?: Address;
  title: string;
  ipfsHash?: string;
}

/** Raw escrow data from contract (before type narrowing to Address/Hex) */
export interface RawEscrowData {
  token: `0x${string}`;
  buyer: `0x${string}`;
  seller: `0x${string}`;
  arbiter: `0x${string}`;
  wallet: `0x${string}`;
  amount: bigint;
  depositTime: bigint;
  maturityTime: bigint;
  disputeStartTime: bigint;
  state: number;
  buyerCancelRequested: boolean;
  sellerCancelRequested: boolean;
  tokenDecimals: number;
  sellerWalletSig: `0x${string}`;
  buyerWalletSig: `0x${string}`;
  arbiterWalletSig: `0x${string}`;
}

/** Parsed escrow data with proper types */
export interface EscrowData {
  token: Address;
  buyer: Address;
  seller: Address;
  arbiter: Address;
  wallet: Address;
  amount: bigint;
  depositTime: bigint;
  maturityTime: bigint;
  disputeStartTime: bigint;
  state: EscrowState;
  buyerCancelRequested: boolean;
  sellerCancelRequested: boolean;
  tokenDecimals: number;
  sellerWalletSig: Hex;
  buyerWalletSig: Hex;
  arbiterWalletSig: Hex;
}

export interface EscrowCreatedEvent {
  escrowId: bigint;
  buyer: Address;
  seller: Address;
  token: Address;
  amount: bigint;
  arbiter: Address;
  maturityTime: bigint;
  title: string;
  ipfsHash: string;
}

export interface DisputeSubmissionStatus {
  buyer: boolean;
  seller: boolean;
  arbiter: boolean;
  allSubmitted: boolean;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function assertWalletClient(
  client: EscrowWalletClient | undefined
): asserts client is EscrowWalletClient {
  if (!client) {
    throw new SDKError("Wallet client is required", SDKErrorCode.WALLET_NOT_CONNECTED);
  }
  if (!client.account) {
    throw new SDKError("Wallet account is required", SDKErrorCode.WALLET_ACCOUNT_MISSING);
  }
}

/**
 * Validate and normalize an Ethereum address using EIP-55 checksum.
 * Throws SDKError if invalid.
 */
function validateAddress(address: string, fieldName: string = "address"): Address {
  try {
    return getAddress(address);
  } catch {
    throw new SDKError(
      `Invalid ${fieldName}: ${address}`,
      SDKErrorCode.VALIDATION_ERROR,
    );
  }
}

/**
 * Check if address is the zero address
 */
function isZeroAddress(address: Address): boolean {
  return address === zeroAddress;
}

/**
 * Validate signature format (65 bytes = 130 hex chars + 0x prefix)
 */
function validateSignature(signature: Hex, context: string = "signature"): void {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    throw new SDKError(
      `Invalid ${context} format: expected 65-byte hex signature`,
      SDKErrorCode.VALIDATION_ERROR,
    );
  }
}

/**
 * Compare two addresses for equality (case-insensitive, normalized).
 * More efficient than repeated toLowerCase() calls.
 */
function addressEquals(a: Address | string, b: Address | string): boolean {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

// ============================================================================
// MAIN SDK CLASS
// ============================================================================

export class PalindromePaySDK {
  readonly contractAddress: Address;
  readonly abiEscrow: Abi;
  readonly abiWallet: Abi;
  readonly abiERC20: Abi;
  readonly publicClient: PublicClient;
  readonly walletClient?: EscrowWalletClient;
  readonly apollo: ApolloClient;
  readonly chain: Chain;

  private readonly cacheTTL: number;
  private readonly maxCacheSize: number;
  private readonly enableRetry: boolean;
  private readonly maxRetries: number;
  private readonly retryDelay: number;
  private readonly gasBuffer: number;
  private readonly receiptTimeout: number;
  private readonly skipSimulation: boolean;
  private readonly defaultGasLimit: bigint;
  private readonly logger: SDKLogger;
  private readonly logLevel: LogLevel;

  /** LRU cache for escrow data with automatic eviction */
  private escrowCache: Map<string, { data: unknown; timestamp: number }> = new Map();
  /** Cache for token decimals (rarely changes, no eviction needed) */
  private tokenDecimalsCache: Map<Address, number> = new Map();
  /** Cache for immutable contract values */
  private feeReceiverCache: Address | null = null;
  /** Cached multicall support status per chain (null = not yet detected) */
  private multicallSupported: boolean | null = null;

  private readonly STATE_NAMES = [
    "AWAITING_PAYMENT",
    "AWAITING_DELIVERY",
    "DISPUTED",
    "COMPLETE",
    "REFUNDED",
    "CANCELED",
  ] as const;

  constructor(config: PalindromePaySDKConfig) {
    // Use default contract address if none provided
    this.contractAddress = config.contractAddress ?? CONFIG.DEFAULT_CONTRACT_ADDRESS;
    this.abiEscrow = PalindromePayABI.abi as Abi;
    this.abiWallet = PalindromePayWalletABI.abi as Abi;
    this.abiERC20 = ERC20ABI.abi as Abi;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.chain = config.chain ?? hardhat;
    this.cacheTTL = config.cacheTTL ?? DEFAULT_CACHE_TTL;
    this.maxCacheSize = config.maxCacheSize ?? 1000;
    this.enableRetry = config.enableRetry ?? true;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.gasBuffer = config.gasBuffer ?? 20;
    this.receiptTimeout = config.receiptTimeout ?? DEFAULT_RECEIPT_TIMEOUT;
    this.skipSimulation = config.skipSimulation ?? false;
    this.defaultGasLimit = config.defaultGasLimit ?? 500000n;
    this.logLevel = config.logLevel ?? 'info';
    this.logger = config.logger ?? (this.logLevel === 'none' ? noOpLogger : defaultLogger);

    if (!config.apolloClient) {
      throw new SDKError("apolloClient is required", SDKErrorCode.VALIDATION_ERROR);
    }
    this.apollo = config.apolloClient;
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Internal logging helper that respects log level configuration
   */
  private log(level: Exclude<LogLevel, 'none'>, message: string, context?: Record<string, unknown>): void {
    const levels: LogLevel[] = ['debug', 'info', 'warn', 'error', 'none'];
    const currentLevelIndex = levels.indexOf(this.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex >= currentLevelIndex && messageLevelIndex < 4) {
      this.logger[level](message, context);
    }
  }

  /**
   * Execute a contract write with resilient simulation handling.
   *
   * This method handles unreliable RPC simulation on certain chains (e.g., Base Sepolia)
   * by falling back to direct transaction sending when simulation fails.
   *
   * @param walletClient - The wallet client to use
   * @param params - Contract call parameters
   * @param params.address - Contract address
   * @param params.abi - Contract ABI
   * @param params.functionName - Function to call
   * @param params.args - Function arguments
   * @returns Transaction hash
   */
  private async resilientWriteContract(
    walletClient: EscrowWalletClient,
    params: {
      address: Address;
      abi: Abi;
      functionName: string;
      args: readonly unknown[];
    },
  ): Promise<Hex> {
    const { address, abi, functionName, args } = params;

    // Path 1: Skip simulation entirely if configured
    if (this.skipSimulation) {
      this.log('debug', `Skipping simulation for ${functionName}, sending directly`);
      return this.sendTransactionDirect(walletClient, params);
    }

    // Path 2: Try normal write with simulation
    try {
      return await walletClient.writeContract({
        address,
        abi,
        functionName,
        args,
        account: walletClient.account,
        chain: this.chain,
      });
    } catch (error: unknown) {
      // Path 3: Conditional fallback based on error type
      if (!this.isSimulationErrorType(error)) {
        throw error; // Not a simulation error, propagate
      }

      // Simulation failed - send directly as fallback
      this.log('warn', `Simulation failed for ${functionName}, bypassing to send directly`, {
        error: isViemError(error) ? error.message?.slice(0, 100) : String(error),
        functionName,
      });

      return this.sendTransactionDirect(walletClient, params);
    }
  }

  /**
   * Wait for transaction receipt with timeout and retry logic.
   */
  private async waitForReceipt(hash: Hex): Promise<TransactionReceipt> {
    return this.withRetry(async () => {
      try {
        return await this.publicClient.waitForTransactionReceipt({
          hash,
          timeout: this.receiptTimeout,
        });
      } catch (error: unknown) {
        const errorMessage = isViemError(error) ? error.message : String(error);
        if (errorMessage.includes("timed out") || errorMessage.includes("timeout")) {
          throw new SDKError(
            `Transaction receipt timeout after ${this.receiptTimeout}ms`,
            SDKErrorCode.TRANSACTION_FAILED,
            { hash },
          );
        }
        throw error;
      }
    }, "waitForTransactionReceipt");
  }

  /**
   * Execute an async operation with retry logic.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string = "operation",
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: unknown) {
        lastError = error;

        // Don't retry on validation errors or user rejections
        const errorCode = (error as any)?.code;
        const errorName = (error as any)?.name;

        if (
          errorCode === SDKErrorCode.VALIDATION_ERROR ||
          errorCode === USER_REJECTION_CODE || // User rejected
          errorName === "SDKError"
        ) {
          throw error;
        }

        // Only retry if retries are enabled and we have attempts left
        if (!this.enableRetry || attempt >= this.maxRetries) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        const delay = this.retryDelay * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError ?? new SDKError(
      `${operationName} failed after ${this.maxRetries} attempts`,
      SDKErrorCode.RPC_ERROR,
    );
  }

  /**
   * Extract error message from unknown error type.
   */
  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (isViemError(error)) {
      return error.shortMessage || error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return String(error);
  }

  /**
   * Validate common escrow creation parameters.
   */
  private validateCreateEscrowParams(params: {
    tokenAddress: Address;
    buyerAddress: Address;
    sellerAddress: Address;
    arbiterAddress: Address;
    amount: bigint;
    maturityDays: bigint;
    title: string;
  }): void {
    const { tokenAddress, buyerAddress, sellerAddress, amount, maturityDays, title } = params;

    if (!tokenAddress || tokenAddress === zeroAddress) {
      throw new SDKError("Invalid token address", SDKErrorCode.VALIDATION_ERROR);
    }
    if (!buyerAddress || buyerAddress === zeroAddress) {
      throw new SDKError("Invalid buyer address", SDKErrorCode.VALIDATION_ERROR);
    }
    if (!sellerAddress || sellerAddress === zeroAddress) {
      throw new SDKError("Invalid seller address", SDKErrorCode.VALIDATION_ERROR);
    }
    // Note: arbiterAddress can be zeroAddress (no arbiter)
    if (amount <= 0n) {
      throw new SDKError("Amount must be greater than 0", SDKErrorCode.VALIDATION_ERROR);
    }
    if (maturityDays < 0n) {
      throw new SDKError("Maturity days cannot be negative", SDKErrorCode.VALIDATION_ERROR);
    }
    if (maturityDays > MAX_MATURITY_DAYS) {
      throw new SDKError(
        `Maturity days cannot exceed ${MAX_MATURITY_DAYS} days (10 years)`,
        SDKErrorCode.VALIDATION_ERROR,
      );
    }
    if (!title || title.trim().length === 0) {
      throw new SDKError("Title cannot be empty", SDKErrorCode.VALIDATION_ERROR);
    }
    if (title.length > MAX_STRING_LENGTH) {
      throw new SDKError(
        `Title must be ${MAX_STRING_LENGTH} characters or less`,
        SDKErrorCode.VALIDATION_ERROR,
      );
    }
  }

  /**
   * Verify caller is the buyer, throw if not.
   */
  private verifyBuyer(caller: Address, escrow: EscrowData): void {
    if (!addressEquals(caller, escrow.buyer)) {
      throw new SDKError("Only buyer can perform this action", SDKErrorCode.NOT_BUYER);
    }
  }

  /**
   * Verify caller is the seller, throw if not.
   */
  private verifySeller(caller: Address, escrow: EscrowData): void {
    if (!addressEquals(caller, escrow.seller)) {
      throw new SDKError("Only seller can perform this action", SDKErrorCode.NOT_SELLER);
    }
  }

  /**
   * Verify caller is the arbiter, throw if not.
   */
  private verifyArbiter(caller: Address, escrow: EscrowData): void {
    if (!addressEquals(caller, escrow.arbiter)) {
      throw new SDKError("Only arbiter can perform this action", SDKErrorCode.NOT_ARBITER);
    }
  }

  /**
   * Verify escrow is in expected state, throw if not.
   */
  private verifyState(escrow: EscrowData, expectedState: EscrowState, actionName: string): void {
    if (escrow.state !== expectedState) {
      throw new SDKError(
        `Cannot ${actionName}: escrow is in state ${escrow.state}, expected ${expectedState}`,
        SDKErrorCode.INVALID_STATE,
      );
    }
  }

  /**
   * Send transaction directly without simulation.
   * Encodes function data manually and sends with fixed gas limit.
   *
   * @param walletClient - The wallet client to send from
   * @param params - Contract write parameters
   * @returns Transaction hash
   */
  private async sendTransactionDirect(
    walletClient: EscrowWalletClient,
    params: {
      address: Address;
      abi: Abi;
      functionName: string;
      args: readonly unknown[];
    }
  ): Promise<Hex> {
    const { address, abi, functionName, args } = params;

    const data = encodeFunctionData({ abi, functionName, args });

    return walletClient.sendTransaction({
      to: address,
      data,
      account: walletClient.account,
      chain: this.chain,
      gas: this.defaultGasLimit,
    });
  }

  /**
   * Detect if error is a simulation failure (not user rejection or validation error).
   *
   * @param error - The error to check
   * @returns True if error is from simulation failure
   */
  private isSimulationErrorType(error: unknown): boolean {
    if (!isViemError(error)) {
      return false;
    }

    // User rejection is NOT a simulation error
    if (error.code === USER_REJECTION_CODE) {
      return false;
    }

    // Check for simulation-specific error patterns
    return !!(
      error.message?.includes("simulation") ||
      error.message?.includes("eth_call") ||
      error.message?.includes("execution reverted") ||
      error.cause?.message?.includes("simulation")
    );
  }

  /**
   * Set a value in the LRU cache with automatic eviction.
   */
  private setCacheValue<T>(key: string, data: T): void {
    // If at capacity, remove oldest entry (first in Map)
    if (this.escrowCache.size >= this.maxCacheSize) {
      const oldestKey = this.escrowCache.keys().next().value;
      if (oldestKey) {
        this.escrowCache.delete(oldestKey);
      }
    }

    // Delete and re-add to move to end (most recently used)
    this.escrowCache.delete(key);
    this.escrowCache.set(key, { data, timestamp: Date.now() });
  }

  /**
   * Get a value from the LRU cache, refreshing its position.
   */
  private getCacheValue<T>(key: string): T | undefined {
    const cached = this.escrowCache.get(key);
    if (!cached) return undefined;

    // Check TTL
    if (Date.now() - cached.timestamp > this.cacheTTL) {
      this.escrowCache.delete(key);
      return undefined;
    }

    // Move to end (most recently used)
    this.escrowCache.delete(key);
    this.escrowCache.set(key, cached);

    return cached.data as T;
  }

  // ==========================================================================
  // WALLET SIGNATURE HELPERS (EIP-712)
  // ==========================================================================

  /**
   * Get the EIP-712 domain for wallet authorization signatures
   */
  private getWalletDomain(walletAddress: Address) {
    return {
      name: "PalindromePayWallet",
      version: "1",
      chainId: this.chain.id,
      verifyingContract: walletAddress,
    } as const;
  }

  /**
   * Get the EIP-712 domain for escrow contract signatures
   */
  private getEscrowDomain() {
    return {
      name: "PalindromeCryptoEscrow",
      version: "1",
      chainId: this.chain.id,
      verifyingContract: this.contractAddress,
    } as const;
  }

  private readonly walletAuthorizationTypes = {
    WalletAuthorization: [
      { name: "escrowId", type: "uint256" },
      { name: "wallet", type: "address" },
      { name: "participant", type: "address" },
    ],
  } as const;

  private readonly confirmDeliveryTypes = {
    ConfirmDelivery: [
      { name: "escrowId", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "depositTime", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  } as const;

  private readonly startDisputeTypes = {
    StartDispute: [
      { name: "escrowId", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "depositTime", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
    ],
  } as const;

  /**
   * Sign a wallet authorization for a participant
   * Used for: deposit, confirmDelivery, requestCancel, submitArbiterDecision
   */
  async signWalletAuthorization(
    walletClient: EscrowWalletClient,
    walletAddress: Address,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain: this.getWalletDomain(walletAddress),
      types: this.walletAuthorizationTypes,
      primaryType: "WalletAuthorization",
      message: {
        escrowId,
        wallet: walletAddress,
        participant: walletClient.account.address,
      },
    });

    validateSignature(signature as Hex, "wallet authorization signature");
    return signature as Hex;
  }

  /**
   * Verify a wallet authorization signature locally before submitting transaction
   * This ensures the signature is cryptographically valid for the expected signer
   */
  private async verifyWalletSignature(
    signature: Hex,
    walletAddress: Address,
    escrowId: bigint,
    expectedSigner: Address,
  ): Promise<boolean> {
    try {
      return await verifyTypedData({
        address: expectedSigner,
        domain: this.getWalletDomain(walletAddress),
        types: this.walletAuthorizationTypes,
        primaryType: "WalletAuthorization",
        message: {
          escrowId,
          wallet: walletAddress,
          participant: expectedSigner,
        },
        signature,
      });
    } catch (error) {
      this.log('warn', 'Signature verification failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Sign a confirm delivery message (for gasless meta-tx)
   */
  async signConfirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain: this.getEscrowDomain(),
      types: this.confirmDeliveryTypes,
      primaryType: "ConfirmDelivery",
      message: {
        escrowId,
        buyer: deal.buyer,
        seller: deal.seller,
        arbiter: deal.arbiter,
        token: deal.token,
        amount: deal.amount,
        depositTime: deal.depositTime,
        deadline,
        nonce,
      },
    });

    validateSignature(signature as Hex, "confirm delivery signature");
    return signature as Hex;
  }

  /**
   * Sign a start dispute message (for gasless meta-tx)
   */
  async signStartDispute(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain: this.getEscrowDomain(),
      types: this.startDisputeTypes,
      primaryType: "StartDispute",
      message: {
        escrowId,
        buyer: deal.buyer,
        seller: deal.seller,
        arbiter: deal.arbiter,
        token: deal.token,
        amount: deal.amount,
        depositTime: deal.depositTime,
        deadline,
        nonce,
      },
    });

    validateSignature(signature as Hex, "start dispute signature");
    return signature as Hex;
  }

  /**
   * Create a signature deadline (timestamp + minutes)
   */
  async createSignatureDeadline(minutesFromNow: number = 10): Promise<bigint> {
    const block = await this.publicClient.getBlock();
    return BigInt(Number(block.timestamp) + minutesFromNow * 60);
  }

  /**
   * Check if signature deadline has expired
   */
  isSignatureDeadlineExpired(deadline: bigint, safetySeconds = 5): boolean {
    const now = Math.floor(Date.now() / 1000) + safetySeconds;
    return BigInt(now) > deadline;
  }

  // ==========================================================================
  // ADDRESS PREDICTION (CREATE2)
  // ==========================================================================

  /**
   * Predict the wallet address for a given escrow ID (before creation)
   * Calls the contract's computeWalletAddress function - single source of truth
   */
  async predictWalletAddress(escrowId: bigint): Promise<Address> {
    const predicted = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: PalindromePayABI.abi as Abi,
      functionName: "computeWalletAddress",
      args: [escrowId],
    });
    return predicted as Address;
  }

  // ==========================================================================
  // ESCROW DATA READING
  // ==========================================================================

  /**
   * Get raw escrow data from contract
   */
  async getEscrowById(escrowId: bigint): Promise<RawEscrowData> {
    const raw = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getEscrow",
      args: [escrowId],
    });
    return raw as RawEscrowData;
  }

  /**
   * Get parsed escrow data
   */
  async getEscrowByIdParsed(escrowId: bigint): Promise<EscrowData> {
    const raw = await this.getEscrowById(escrowId);
    return {
      token: raw.token as Address,
      buyer: raw.buyer as Address,
      seller: raw.seller as Address,
      arbiter: raw.arbiter as Address,
      wallet: raw.wallet as Address,
      amount: raw.amount as bigint,
      depositTime: raw.depositTime as bigint,
      maturityTime: raw.maturityTime as bigint,
      disputeStartTime: raw.disputeStartTime as bigint,
      state: Number(raw.state) as EscrowState,
      buyerCancelRequested: raw.buyerCancelRequested as boolean,
      sellerCancelRequested: raw.sellerCancelRequested as boolean,
      tokenDecimals: Number(raw.tokenDecimals),
      sellerWalletSig: raw.sellerWalletSig as Hex,
      buyerWalletSig: raw.buyerWalletSig as Hex,
      arbiterWalletSig: raw.arbiterWalletSig as Hex,
    };
  }

  /**
   * Get next escrow ID
   */
  async getNextEscrowId(): Promise<bigint> {
    return readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "nextEscrowId",
    }) as Promise<bigint>;
  }

  // ==========================================================================
  // NONCE MANAGEMENT (Contract-Based)
  // ==========================================================================

  /**
   * Get the nonce bitmap from the contract.
   * 
   * Each bitmap word contains NONCE_BITMAP_SIZE nonce states. A set bit means the nonce is used.
   * 
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param wordIndex - The word index (nonce / NONCE_BITMAP_SIZE)
   * @returns The bitmap as a bigint
   */
  async getNonceBitmap(escrowId: bigint, signer: Address, wordIndex: bigint = 0n): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getNonceBitmap",
      args: [escrowId, signer, wordIndex],
    }) as Promise<bigint>;
  }

  /**
   * Check if a specific nonce has been used.
   * 
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param nonce - The nonce to check
   * @returns True if the nonce has been used
   */
  async isNonceUsed(escrowId: bigint, signer: Address, nonce: bigint): Promise<boolean> {
    const wordIndex = nonce / 256n;
    const bitIndex = nonce % 256n;
    const bitmap = await this.getNonceBitmap(escrowId, signer, wordIndex);
    return (bitmap & (1n << bitIndex)) !== 0n;
  }

  /**
   * Maximum nonce word index to prevent infinite loops.
   * 100 words = 25,600 nonces per escrow per signer.
   */
  private static readonly MAX_NONCE_WORDS = 100n;

  /**
   * Get the next available nonce for a signer.
   *
   * Queries the contract's nonce bitmap and finds the first unused nonce.
   * This is the recommended way to get a nonce for signed transactions.
   *
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @returns The next available nonce
   * @throws SDKError if nonce space is exhausted (> 25,600 nonces used)
   */
  async getUserNonce(escrowId: bigint, signer: Address): Promise<bigint> {
    // Start with word 0 (nonces 0-255)
    let wordIndex = 0n;

    while (wordIndex < PalindromePaySDK.MAX_NONCE_WORDS) {
      const bitmap = await this.getNonceBitmap(escrowId, signer, wordIndex);

      // If bitmap is all 1s (all NONCE_BITMAP_SIZE nonces used), check next word
      if (bitmap === (1n << 256n) - 1n) {
        wordIndex++;
        continue;
      }

      // Find first zero bit (unused nonce)
      for (let i = 0n; i < 256n; i++) {
        if ((bitmap & (1n << i)) === 0n) {
          return wordIndex * 256n + i;
        }
      }

      // Shouldn't reach here, but just in case
      wordIndex++;
    }

    throw new SDKError(
      "Nonce space exhausted: too many nonces used for this escrow/signer",
      SDKErrorCode.VALIDATION_ERROR,
    );
  }

  /**
   * Calculate estimated number of bitmap words needed for nonce count.
   * Uses conservative estimate with buffer to minimize round trips.
   *
   * @param count - Number of nonces needed
   * @returns Estimated number of bitmap words to fetch
   */
  private getEstimatedWordCount(count: number): number {
    return Math.min(
      Math.ceil(count / 128) + 1, // Conservative estimate with buffer
      Number(PalindromePaySDK.MAX_NONCE_WORDS)
    );
  }

  /**
   * Detect if chain supports Multicall3 and cache result.
   * Performs a test multicall on first invocation and caches the result.
   *
   * @param escrowId - Escrow ID for test call
   * @param signer - Signer address for test call
   */
  private async detectMulticallSupport(
    escrowId: bigint,
    signer: Address
  ): Promise<void> {
    if (this.multicallSupported !== null) {
      return; // Already detected
    }

    this.log('debug', 'Detecting multicall support...');
    try {
      await multicall(this.publicClient, {
        contracts: [{
          address: this.contractAddress,
          abi: this.abiEscrow,
          functionName: "getNonceBitmap",
          args: [escrowId, signer, 0n],
        }],
      });
      this.multicallSupported = true;
      this.log('info', 'Multicall3 supported on this chain');
    } catch (error: unknown) {
      const message = this.extractErrorMessage(error);
      if (message.includes("multicall") || message.includes("Chain")) {
        this.multicallSupported = false;
        this.log('info', 'Multicall3 not supported, using sequential calls');
      } else {
        throw error; // Different error, re-throw
      }
    }
  }

  /**
   * Fetch nonce bitmaps using either multicall or sequential calls.
   * Automatically uses multicall if supported, otherwise falls back to sequential.
   *
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param wordCount - Number of bitmap words to fetch
   * @returns Array of bitmap results with status
   */
  private async fetchNonceBitmaps(
    escrowId: bigint,
    signer: Address,
    wordCount: number
  ): Promise<Array<{ status: string; result?: bigint }>> {
    if (this.multicallSupported) {
      // Use multicall for efficiency
      const results = await multicall(this.publicClient, {
        contracts: Array.from({ length: wordCount }, (_, i) => ({
          address: this.contractAddress,
          abi: this.abiEscrow,
          functionName: "getNonceBitmap",
          args: [escrowId, signer, BigInt(i)],
        })),
      });
      return results as Array<{ status: string; result?: bigint }>;
    } else {
      // Sequential fallback for chains without multicall
      return Promise.all(
        Array.from({ length: wordCount }, async (_, i) => {
          try {
            const result = await this.getNonceBitmap(escrowId, signer, BigInt(i));
            return { status: "success", result };
          } catch {
            return { status: "failure" };
          }
        })
      );
    }
  }

  /**
   * Scan bitmap words for available (unused) nonces.
   * Performs bit-level scanning with early exit when count is reached.
   *
   * @param bitmapResults - Array of bitmap words fetched from contract
   * @param count - Maximum number of nonces to find
   * @returns Array of available nonce values
   */
  private scanBitmapsForNonces(
    bitmapResults: Array<{ status: string; result?: bigint }>,
    count: number
  ): bigint[] {
    const nonces: bigint[] = [];

    for (let wordIdx = 0; wordIdx < bitmapResults.length && nonces.length < count; wordIdx++) {
      const wordResult = bitmapResults[wordIdx];

      if (wordResult.status !== "success" || wordResult.result === undefined) {
        continue; // Skip failed fetches
      }

      const bitmap = wordResult.result;
      const baseNonce = BigInt(wordIdx) * BigInt(NONCE_BITMAP_SIZE);

      // Scan each bit in the word (0 = available, 1 = used)
      for (let bitPos = 0n; bitPos < BigInt(NONCE_BITMAP_SIZE) && nonces.length < count; bitPos++) {
        if ((bitmap & (1n << bitPos)) === 0n) {
          nonces.push(baseNonce + bitPos);
        }
      }
    }

    return nonces;
  }

  /**
   * Get multiple available nonces at once (for batch operations).
   *
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param count - Number of nonces to retrieve (max NONCE_BITMAP_SIZE)
   * @returns Array of available nonces
   * @throws SDKError if count exceeds limit or nonce space is exhausted
   */
  async getMultipleNonces(escrowId: bigint, signer: Address, count: number): Promise<bigint[]> {
    // 1. Input validation
    if (count > NONCE_BITMAP_SIZE) {
      throw new SDKError(
        `Cannot request more than ${NONCE_BITMAP_SIZE} nonces at once`,
        SDKErrorCode.VALIDATION_ERROR,
      );
    }
    if (count <= 0) {
      return [];
    }

    // 2. Detect multicall support (cached after first call)
    await this.detectMulticallSupport(escrowId, signer);

    // 3. Fetch bitmap words
    const estimatedWords = this.getEstimatedWordCount(count);
    const bitmapResults = await this.fetchNonceBitmaps(escrowId, signer, estimatedWords);

    // 4. Scan bitmaps for available nonces
    const nonces = this.scanBitmapsForNonces(bitmapResults, count);

    // 5. Verify we found enough nonces
    if (nonces.length < count) {
      throw new SDKError(
        `Could only find ${nonces.length} available nonces out of ${count} requested`,
        SDKErrorCode.VALIDATION_ERROR,
      );
    }

    return nonces;
  }

  /**
   * @deprecated No longer needed - nonces are tracked by the contract
   */
  resetNonceTracker(): void {
    // No-op: Contract tracks nonces now
  }

  /**
   * Get dispute submission status
   */
  async getDisputeSubmissionStatus(escrowId: bigint): Promise<DisputeSubmissionStatus> {
    const status = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "disputeStatus",
      args: [escrowId],
    }) as bigint;

    const buyer = (status & 1n) !== 0n;
    const seller = (status & 2n) !== 0n;
    const arbiter = (status & 4n) !== 0n;

    return { buyer, seller, arbiter, allSubmitted: buyer && seller && arbiter };
  }

  // ==========================================================================
  // TOKEN UTILITIES
  // ==========================================================================

  async getTokenDecimals(tokenAddress: Address): Promise<number> {
    if (this.tokenDecimalsCache.has(tokenAddress)) {
      return this.tokenDecimalsCache.get(tokenAddress)!;
    }

    const decimals = await this.publicClient.readContract({
      address: tokenAddress,
      abi: this.abiERC20,
      functionName: "decimals",
    }) as number;

    this.tokenDecimalsCache.set(tokenAddress, decimals);
    return decimals;
  }

  async getTokenBalance(account: Address, tokenAddress: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: this.abiERC20,
      functionName: "balanceOf",
      args: [account],
    }) as Promise<bigint>;
  }

  async getTokenAllowance(owner: Address, spender: Address, tokenAddress: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: tokenAddress,
      abi: this.abiERC20,
      functionName: "allowance",
      args: [owner, spender],
    }) as Promise<bigint>;
  }

  formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const integerPart = amount / divisor;
    const fractionalPart = (amount % divisor).toString().padStart(decimals, "0");
    return `${integerPart}.${fractionalPart}`;
  }

  /**
   * Approve token spending if needed
   */
  async approveTokenIfNeeded(
    walletClient: EscrowWalletClient,
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<Hex | null> {
    assertWalletClient(walletClient);

    const currentAllowance = await this.getTokenAllowance(
      walletClient.account.address,
      spender,
      token,
    );

    if (currentAllowance >= amount) return null;

    const hash = await this.resilientWriteContract(walletClient, {
      address: token,
      abi: this.abiERC20,
      functionName: "approve",
      args: [spender, amount],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // ESCROW CREATION
  // ==========================================================================

  /**
   * Create a new escrow as the seller
   *
   * This function creates a new escrow where the caller (seller) is offering goods/services
   * to a buyer. The escrow starts in AWAITING_PAYMENT state until the buyer deposits funds.
   *
   * The seller's wallet authorization signature is automatically generated and attached,
   * which will be used later for 2-of-3 multisig withdrawals from the escrow wallet.
   *
   * @param walletClient - The seller's wallet client (must have account connected)
   * @param params - Escrow creation parameters
   * @param params.token - ERC20 token address for payment
   * @param params.buyer - Buyer's wallet address
   * @param params.amount - Payment amount in token's smallest unit (e.g., wei for 18 decimals)
   * @param params.maturityTimeDays - Optional days until maturity (default: 1, min: 1, max: 3650)
   * @param params.arbiter - Optional arbiter address for dispute resolution
   * @param params.title - Escrow title/description (1-500 characters, supports encrypted hashes)
   * @param params.ipfsHash - Optional IPFS hash for additional details
   * @returns Object containing escrowId, transaction hash, and wallet address
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} VALIDATION_ERROR - If parameters are invalid
   * @throws {SDKError} TRANSACTION_FAILED - If the transaction fails
   */
  async createEscrow(
    walletClient: EscrowWalletClient,
    params: CreateEscrowParams,
  ): Promise<{ escrowId: bigint; txHash: Hex; walletAddress: Address; signatureValid: boolean; verificationError?: string }> {
    assertWalletClient(walletClient);

    // Validate and normalize addresses
    const token = validateAddress(params.token, "token");
    const buyer = validateAddress(params.buyer, "buyer");
    const sellerAddress = walletClient.account.address;

    // Use zero address if no arbiter provided (no dispute resolution)
    const arbiter: Address = params.arbiter
      ? validateAddress(params.arbiter, "arbiter")
      : zeroAddress;
    const maturityDays = params.maturityTimeDays ?? 1n;

    // Validate using helper
    this.validateCreateEscrowParams({
      tokenAddress: token,
      buyerAddress: buyer,
      sellerAddress,
      arbiterAddress: arbiter,
      amount: params.amount,
      maturityDays,
      title: params.title,
    });

    // Validate arbiter is not buyer or seller (skip if zero address - no arbiter)
    if (!isZeroAddress(arbiter)) {
      if (getAddress(arbiter) === getAddress(buyer)) {
        throw new SDKError("Arbiter cannot be the buyer", SDKErrorCode.VALIDATION_ERROR);
      }
      if (getAddress(arbiter) === getAddress(sellerAddress)) {
        throw new SDKError("Arbiter cannot be the seller", SDKErrorCode.VALIDATION_ERROR);
      }
    }

    const ipfsHash = params.ipfsHash ?? "";

    // Predict next escrow ID and wallet address
    const nextId = await this.getNextEscrowId();
    const predictedWallet = await this.predictWalletAddress(nextId);

    // Sign wallet authorization
    const sellerWalletSig = await this.signWalletAuthorization(
      walletClient,
      predictedWallet,
      nextId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      sellerWalletSig,
      predictedWallet,
      nextId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Seller wallet signature is invalid - cannot create escrow",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Create escrow
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "createEscrow",
      args: [
        token,
        buyer,
        params.amount,
        maturityDays,
        arbiter,
        params.title,
        ipfsHash,
        sellerWalletSig,
      ],
    });

    const receipt = await this.waitForReceipt(hash);

    if (receipt.status !== "success") {
      throw new SDKError("Transaction failed", SDKErrorCode.TRANSACTION_FAILED, { txHash: hash });
    }

    // Parse event to get escrow ID
    const events = parseEventLogs({
      abi: this.abiEscrow,
      eventName: "EscrowCreated",
      logs: receipt.logs,
    }) as Array<{ args: EscrowCreatedEvent }>;

    const escrowId = events[0]?.args?.escrowId ?? nextId;
    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify seller signature is valid on-chain after creation
    let sellerSigValid = false;
    let verificationError: string | undefined;
    try {
      sellerSigValid = await this.publicClient.readContract({
        address: deal.wallet,
        abi: this.abiWallet,
        functionName: "isSignatureValid",
        args: [walletClient.account.address],
      }) as boolean;
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
      this.log('warn', 'Failed to verify seller signature after escrow creation', {
        escrowId: escrowId.toString(),
        error: verificationError,
      });
    }

    if (!sellerSigValid && !verificationError) {
      this.log('error', 'Seller wallet signature is invalid after escrow creation', {
        escrowId: escrowId.toString(),
        seller: walletClient.account.address,
        wallet: deal.wallet,
      });
    }

    return { escrowId, txHash: hash, walletAddress: deal.wallet, signatureValid: sellerSigValid, verificationError };
  }

  /**
   * Create a new escrow and deposit funds as the buyer (single transaction)
   *
   * This function creates a new escrow and immediately deposits the payment in one transaction.
   * The escrow starts in AWAITING_DELIVERY state. The seller must call `acceptEscrow` to
   * provide their wallet signature before funds can be released.
   *
   * Token approval is automatically handled if needed.
   *
   * @param walletClient - The buyer's wallet client (must have account connected)
   * @param params - Escrow creation parameters
   * @param params.token - ERC20 token address for payment
   * @param params.seller - Seller's wallet address
   * @param params.amount - Payment amount in token's smallest unit (e.g., wei for 18 decimals)
   * @param params.maturityTimeDays - Optional days until maturity (default: 1, min: 1, max: 3650)
   * @param params.arbiter - Optional arbiter address for dispute resolution
   * @param params.title - Escrow title/description (1-500 characters, supports encrypted hashes)
   * @param params.ipfsHash - Optional IPFS hash for additional details
   * @returns Object containing escrowId, transaction hash, and wallet address
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} VALIDATION_ERROR - If parameters are invalid
   * @throws {SDKError} INSUFFICIENT_BALANCE - If buyer has insufficient token balance
   * @throws {SDKError} TRANSACTION_FAILED - If the transaction fails
   */
  async createEscrowAndDeposit(
    walletClient: EscrowWalletClient,
    params: CreateEscrowAndDepositParams,
  ): Promise<{ escrowId: bigint; txHash: Hex; walletAddress: Address; signatureValid: boolean; verificationError?: string }> {
    assertWalletClient(walletClient);

    // Validate and normalize addresses
    const token = validateAddress(params.token, "token");
    const seller = validateAddress(params.seller, "seller");
    const buyerAddress = walletClient.account.address;

    // Use zero address if no arbiter provided (no dispute resolution)
    const arbiter: Address = params.arbiter
      ? validateAddress(params.arbiter, "arbiter")
      : zeroAddress;
    const maturityDays = params.maturityTimeDays ?? 1n;

    // Validate using helper
    this.validateCreateEscrowParams({
      tokenAddress: token,
      buyerAddress,
      sellerAddress: seller,
      arbiterAddress: arbiter,
      amount: params.amount,
      maturityDays,
      title: params.title,
    });

    // Validate arbiter is not buyer or seller (skip if zero address - no arbiter)
    if (!isZeroAddress(arbiter)) {
      if (getAddress(arbiter) === getAddress(seller)) {
        throw new SDKError("Arbiter cannot be the seller", SDKErrorCode.VALIDATION_ERROR);
      }
      if (getAddress(arbiter) === getAddress(buyerAddress)) {
        throw new SDKError("Arbiter cannot be the buyer", SDKErrorCode.VALIDATION_ERROR);
      }
    }

    const ipfsHash = params.ipfsHash ?? "";

    // Approve token spending
    await this.approveTokenIfNeeded(
      walletClient,
      token,
      this.contractAddress,
      params.amount,
    );

    // Predict next escrow ID and wallet address
    const nextId = await this.getNextEscrowId();
    const predictedWallet = await this.predictWalletAddress(nextId);

    // Sign wallet authorization
    const buyerWalletSig = await this.signWalletAuthorization(
      walletClient,
      predictedWallet,
      nextId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      buyerWalletSig,
      predictedWallet,
      nextId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Buyer wallet signature is invalid - cannot create escrow",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Create escrow and deposit
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "createEscrowAndDeposit",
      args: [
        token,
        seller,
        params.amount,
        maturityDays,
        arbiter,
        params.title,
        ipfsHash,
        buyerWalletSig,
      ],
    });

    const receipt = await this.waitForReceipt(hash);

    if (receipt.status !== "success") {
      throw new SDKError("Transaction failed", SDKErrorCode.TRANSACTION_FAILED, { txHash: hash });
    }

    // Parse event to get escrow ID
    const events = parseEventLogs({
      abi: this.abiEscrow,
      eventName: "EscrowCreated",
      logs: receipt.logs,
    }) as Array<{ args: EscrowCreatedEvent }>;

    const escrowId = events[0]?.args?.escrowId ?? nextId;
    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify buyer signature is valid on-chain after creation
    let buyerSigValid = false;
    let verificationError: string | undefined;
    try {
      buyerSigValid = await this.publicClient.readContract({
        address: deal.wallet,
        abi: this.abiWallet,
        functionName: "isSignatureValid",
        args: [walletClient.account.address],
      }) as boolean;
    } catch (error) {
      verificationError = error instanceof Error ? error.message : String(error);
      this.log('warn', 'Failed to verify buyer signature after escrow creation', {
        escrowId: escrowId.toString(),
        error: verificationError,
      });
    }

    if (!buyerSigValid && !verificationError) {
      this.log('error', 'Buyer wallet signature is invalid after escrow creation', {
        escrowId: escrowId.toString(),
        buyer: walletClient.account.address,
        wallet: deal.wallet,
      });
    }

    return { escrowId, txHash: hash, walletAddress: deal.wallet, signatureValid: buyerSigValid, verificationError };
  }

  // ==========================================================================
  // DEPOSIT
  // ==========================================================================

  /**
   * Deposit funds into an existing escrow as the buyer
   *
   * This function is used when the seller created the escrow via `createEscrow`.
   * The buyer deposits the required payment amount, transitioning the escrow from
   * AWAITING_PAYMENT to AWAITING_DELIVERY state.
   *
   * Token approval is automatically handled if needed.
   * The buyer's wallet authorization signature is automatically generated.
   *
   * @param walletClient - The buyer's wallet client (must have account connected)
   * @param escrowId - The escrow ID to deposit into
   * @returns Object containing transaction hash and signature validity
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_BUYER - If caller is not the designated buyer
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_PAYMENT state
   * @throws {SDKError} INSUFFICIENT_BALANCE - If buyer has insufficient token balance
   */
  async deposit(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{ txHash: Hex; signatureValid: boolean }> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller and state using helpers
    this.verifyBuyer(walletClient.account.address, deal);
    this.verifyState(deal, EscrowState.AWAITING_PAYMENT, "deposit");

    // Approve token spending
    await this.approveTokenIfNeeded(
      walletClient,
      deal.token,
      this.contractAddress,
      deal.amount,
    );

    // Sign wallet authorization using the wallet address from the escrow
    const buyerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      buyerWalletSig,
      deal.wallet,
      escrowId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Buyer wallet signature is invalid - cannot deposit",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Deposit
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "deposit",
      args: [escrowId, buyerWalletSig],
    });

    await this.waitForReceipt(hash);

    // Verify buyer signature is valid on-chain after deposit
    let buyerSigValid = false;
    try {
      buyerSigValid = await this.publicClient.readContract({
        address: deal.wallet,
        abi: this.abiWallet,
        functionName: "isSignatureValid",
        args: [walletClient.account.address],
      }) as boolean;
    } catch (error) {
      this.log('warn', 'Failed to verify buyer signature after deposit', {
        escrowId: escrowId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!buyerSigValid) {
      this.log('error', 'Buyer wallet signature is invalid after deposit', {
        escrowId: escrowId.toString(),
        buyer: walletClient.account.address,
        wallet: deal.wallet,
      });
    }

    return { txHash: hash, signatureValid: buyerSigValid };
  }

  // ==========================================================================
  // ACCEPT ESCROW (for buyer-created escrows)
  // ==========================================================================

  /**
   * Accept an escrow as the seller (for buyer-created escrows)
   *
   * This function is required when the buyer created the escrow via `createEscrowAndDeposit`.
   * The seller must accept to provide their wallet authorization signature, which is
   * required for the 2-of-3 multisig withdrawal mechanism.
   *
   * Without accepting, the seller cannot receive funds even if the buyer confirms delivery.
   *
   * @param walletClient - The seller's wallet client (must have account connected)
   * @param escrowId - The escrow ID to accept
   * @returns Object containing transaction hash and signature validity
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_SELLER - If caller is not the designated seller
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_DELIVERY state
   * @throws {SDKError} ALREADY_ACCEPTED - If escrow was already accepted
   */
  async acceptEscrow(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{ txHash: Hex; signatureValid: boolean }> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller and state using helpers
    this.verifySeller(walletClient.account.address, deal);
    this.verifyState(deal, EscrowState.AWAITING_DELIVERY, "accept");

    // Check if already accepted (seller sig already exists)
    if (deal.sellerWalletSig && deal.sellerWalletSig !== "0x") {
      throw new SDKError("Escrow already accepted", SDKErrorCode.ALREADY_ACCEPTED);
    }

    // Sign wallet authorization using the wallet address from the escrow
    const sellerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      sellerWalletSig,
      deal.wallet,
      escrowId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Seller wallet signature is invalid - cannot accept escrow",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Accept escrow
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "acceptEscrow",
      args: [escrowId, sellerWalletSig],
    });

    await this.waitForReceipt(hash);

    // Verify seller signature is valid on-chain after accept
    let sellerSigValid = false;
    try {
      sellerSigValid = await this.publicClient.readContract({
        address: deal.wallet,
        abi: this.abiWallet,
        functionName: "isSignatureValid",
        args: [walletClient.account.address],
      }) as boolean;
    } catch (error) {
      this.log('warn', 'Failed to verify seller signature after accept', {
        escrowId: escrowId.toString(),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!sellerSigValid) {
      this.log('error', 'Seller wallet signature is invalid after accept', {
        escrowId: escrowId.toString(),
        seller: walletClient.account.address,
        wallet: deal.wallet,
      });
    }

    return { txHash: hash, signatureValid: sellerSigValid };
  }

  // ==========================================================================
  // CONFIRM DELIVERY
  // ==========================================================================

  /**
   * Confirm delivery and release funds to the seller
   *
   * This function is called by the buyer after receiving the goods/services.
   * It transitions the escrow to COMPLETE state and authorizes payment release to the seller.
   *
   * After confirmation, anyone can call `withdraw` on the escrow wallet to execute
   * the actual token transfer (requires 2-of-3 signatures: buyer + seller).
   *
   * A 1% fee is deducted from the payment amount.
   *
   * @param walletClient - The buyer's wallet client (must have account connected)
   * @param escrowId - The escrow ID to confirm
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_BUYER - If caller is not the designated buyer
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_DELIVERY state
   */
  async confirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller and state using helpers
    this.verifyBuyer(walletClient.account.address, deal);
    this.verifyState(deal, EscrowState.AWAITING_DELIVERY, "confirm delivery");

    // Sign wallet authorization
    const buyerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      buyerWalletSig,
      deal.wallet,
      escrowId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Buyer wallet signature is invalid - cannot confirm delivery",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Confirm delivery
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "confirmDelivery",
      args: [escrowId, buyerWalletSig],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Confirm delivery via meta-transaction (gasless for buyer)
   *
   * This function allows a relayer to submit the confirm delivery transaction on behalf
   * of the buyer. The buyer signs the confirmation off-chain, and the relayer pays the gas.
   *
   * Use `prepareConfirmDeliverySigned` to generate the required signatures.
   *
   * @param walletClient - The relayer's wallet client (pays gas)
   * @param escrowId - The escrow ID to confirm
   * @param coordSignature - Buyer's EIP-712 signature for the confirmation
   * @param deadline - Signature expiration timestamp (must be within 24 hours)
   * @param nonce - Buyer's nonce for replay protection
   * @param buyerWalletSig - Buyer's wallet authorization signature
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} SIGNATURE_EXPIRED - If deadline has passed
   */
  async confirmDeliverySigned(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    coordSignature: Hex,
    deadline: bigint,
    nonce: bigint,
    buyerWalletSig: Hex,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SDKError("Signature deadline expired", SDKErrorCode.SIGNATURE_EXPIRED);
    }

    // Anyone can submit (typically relayer)
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "confirmDeliverySigned",
      args: [escrowId, coordSignature, deadline, nonce, buyerWalletSig],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Prepare signatures for gasless confirm delivery
   *
   * This helper function generates all the signatures needed for a gasless confirm delivery.
   * The buyer signs off-chain, and the resulting data can be sent to a relayer who will
   * submit the transaction and pay the gas.
   *
   * The deadline is set to 60 minutes from the current block timestamp.
   *
   * @param buyerWalletClient - The buyer's wallet client (must have account connected)
   * @param escrowId - The escrow ID to confirm
   * @returns Object containing coordSignature, buyerWalletSig, deadline, and nonce
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_BUYER - If caller is not the designated buyer
   */
  async prepareConfirmDeliverySigned(
    buyerWalletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{
    coordSignature: Hex;
    buyerWalletSig: Hex;
    deadline: bigint;
    nonce: bigint;
  }> {
    assertWalletClient(buyerWalletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller using helper
    this.verifyBuyer(buyerWalletClient.account.address, deal);

    // Parallelize deadline and nonce fetching
    const [deadline, nonce] = await Promise.all([
      this.createSignatureDeadline(60), // 60 minutes
      this.getUserNonce(escrowId, buyerWalletClient.account.address),
    ]);

    // Sign coordinator message and wallet authorization in parallel
    const [coordSignature, buyerWalletSig] = await Promise.all([
      this.signConfirmDelivery(buyerWalletClient, escrowId, deadline, nonce),
      this.signWalletAuthorization(buyerWalletClient, deal.wallet, escrowId),
    ]);

    return { coordSignature, buyerWalletSig, deadline, nonce };
  }

  // ==========================================================================
  // CANCEL FLOWS
  // ==========================================================================

  /**
   * Request cancellation of an escrow
   *
   * This function allows either the buyer or seller to request cancellation.
   * Both parties must call this function for a mutual cancellation to occur.
   *
   * - If only one party requests: The request is recorded, awaiting the other party
   * - If both parties request: The escrow is automatically canceled and funds returned to buyer
   *
   * Use `getCancelRequestStatus` to check if the other party has already requested.
   *
   * @param walletClient - The buyer's or seller's wallet client
   * @param escrowId - The escrow ID to cancel
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} INVALID_ROLE - If caller is not buyer or seller
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_DELIVERY state
   */
  async requestCancel(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);
    // Verify caller is buyer or seller
    const isBuyer = addressEquals(walletClient.account.address, deal.buyer);
    const isSeller = addressEquals(walletClient.account.address, deal.seller);
    if (!isBuyer && !isSeller) {
      throw new SDKError("Only buyer or seller can request cancel", SDKErrorCode.INVALID_ROLE);
    }

    // Verify state
    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new SDKError(
        `Invalid state: ${this.STATE_NAMES[deal.state]}. Expected: AWAITING_DELIVERY`,
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Sign wallet authorization
    const walletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      walletSig,
      deal.wallet,
      escrowId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Wallet signature is invalid - cannot request cancel",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Request cancel
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "requestCancel",
      args: [escrowId, walletSig],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Cancel escrow by timeout (unilateral cancellation by buyer)
   *
   * This function allows the buyer to cancel the escrow unilaterally if:
   * - The buyer has already requested cancellation via `requestCancel`
   * - The maturity time has passed
   * - The seller has not agreed to mutual cancellation
   * - No dispute is active
   * - An arbiter is assigned to the escrow
   *
   * Funds are returned to the buyer without any fee deduction.
   *
   * @param walletClient - The buyer's wallet client (must have account connected)
   * @param escrowId - The escrow ID to cancel
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_BUYER - If caller is not the designated buyer
   * @throws {SDKError} INVALID_STATE - If conditions for timeout cancel are not met
   */
  async cancelByTimeout(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller using helper
    this.verifyBuyer(walletClient.account.address, deal);

    // Cancel by timeout
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "cancelByTimeout",
      args: [escrowId],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Auto-release funds to seller after maturity time
   *
   * This function allows the seller to claim funds unilaterally after the maturity time
   * has passed. This protects sellers when buyers become unresponsive after receiving
   * goods/services.
   *
   * Requirements:
   * - Escrow must be in AWAITING_DELIVERY state
   * - No dispute has been started
   * - Buyer has not requested cancellation
   * - maturityTime has passed
   * - Seller has already provided wallet signature (via createEscrow or acceptEscrow)
   *
   * A 1% fee is deducted from the payment amount.
   *
   * @param walletClient - The seller's wallet client (must have account connected)
   * @param escrowId - The escrow ID to auto-release
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_SELLER - If caller is not the designated seller
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_DELIVERY state
   * @throws {SDKError} INVALID_STATE - If dispute is active or buyer requested cancel
   * @throws {SDKError} VALIDATION_ERROR - If seller wallet signature is missing
   */
  async autoRelease(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller and state using helpers
    this.verifySeller(walletClient.account.address, deal);
    this.verifyState(deal, EscrowState.AWAITING_DELIVERY, "auto-release");

    // Verify no dispute is active
    if (deal.disputeStartTime > 0n) {
      throw new SDKError("Cannot auto-release: dispute is active", SDKErrorCode.INVALID_STATE);
    }

    // Verify buyer hasn't requested cancellation
    if (deal.buyerCancelRequested) {
      throw new SDKError(
        "Cannot auto-release: buyer has requested cancellation",
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Verify deposit exists
    if (deal.depositTime === 0n) {
      throw new SDKError("Cannot auto-release: no deposit made", SDKErrorCode.INVALID_STATE);
    }

    // Verify seller signature exists
    if (!deal.sellerWalletSig || deal.sellerWalletSig === "0x" || deal.sellerWalletSig.length !== 132) {
      throw new SDKError(
        "Cannot auto-release: seller wallet signature missing. Call acceptEscrow first if buyer created the escrow.",
        SDKErrorCode.VALIDATION_ERROR,
      );
    }

    // Auto-release
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "autoRelease",
      args: [escrowId],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // DISPUTE FLOWS
  // ==========================================================================

  /**
   * Start a dispute for an escrow
   *
   * This function initiates a dispute when there's a disagreement between buyer and seller.
   * Once started, the escrow enters DISPUTED state and requires arbiter resolution.
   *
   * Either the buyer or seller can start a dispute. An arbiter must be assigned to the
   * escrow for disputes to be possible.
   *
   * After starting a dispute:
   * 1. Both parties should submit evidence via `submitDisputeMessage`
   * 2. The arbiter reviews evidence and makes a decision via `submitArbiterDecision`
   * 3. The arbiter can rule in favor of buyer (REFUNDED) or seller (COMPLETE)
   *
   * @param walletClient - The buyer's or seller's wallet client
   * @param escrowId - The escrow ID to dispute
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} INVALID_STATE - If escrow is not in AWAITING_DELIVERY state
   */
  async startDispute(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    // Start dispute
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "startDispute",
      args: [escrowId],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Start a dispute via meta-transaction (gasless for buyer/seller)
   *
   * This function allows a relayer to submit the start dispute transaction on behalf
   * of the buyer or seller. The initiator signs off-chain, and the relayer pays the gas.
   *
   * Use `signStartDispute` to generate the required signature.
   *
   * @param walletClient - The relayer's wallet client (pays gas)
   * @param escrowId - The escrow ID to dispute
   * @param signature - Buyer's or seller's EIP-712 signature
   * @param deadline - Signature expiration timestamp (must be within 24 hours)
   * @param nonce - Signer's nonce for replay protection
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} SIGNATURE_EXPIRED - If deadline has passed
   */
  async startDisputeSigned(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    signature: Hex,
    deadline: bigint,
    nonce: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SDKError("Signature deadline expired", SDKErrorCode.SIGNATURE_EXPIRED);
    }

    // Anyone can submit (typically relayer)
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "startDisputeSigned",
      args: [escrowId, signature, deadline, nonce],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Submit evidence for a dispute
   *
   * This function allows the buyer or seller to submit evidence supporting their case.
   * Each party can only submit evidence once. Evidence is stored on IPFS and the hash
   * is recorded on-chain.
   *
   * The arbiter will review submitted evidence before making a decision. Both parties
   * should submit evidence for a fair resolution. After 30 days, the arbiter can make
   * a decision even without complete evidence.
   *
   * @param walletClient - The buyer's or seller's wallet client
   * @param escrowId - The escrow ID
   * @param role - The caller's role (Role.Buyer or Role.Seller)
   * @param ipfsHash - IPFS hash containing the evidence (max 500 characters)
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} EVIDENCE_ALREADY_SUBMITTED - If caller already submitted evidence
   * @throws {SDKError} INVALID_STATE - If escrow is not in DISPUTED state
   */
  async submitDisputeMessage(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    role: Role.Buyer | Role.Seller,
    ipfsHash: string,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    // Check if already submitted
    const hasSubmitted = await this.hasSubmittedEvidence(escrowId, role);
    if (hasSubmitted) {
      throw new SDKError(
        `${role === Role.Buyer ? "Buyer" : "Seller"} has already submitted evidence`,
        SDKErrorCode.EVIDENCE_ALREADY_SUBMITTED,
      );
    }

    // Submit dispute message
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "submitDisputeMessage",
      args: [escrowId, role, ipfsHash],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Submit arbiter's decision to resolve a dispute
   *
   * This function is called by the designated arbiter to resolve a dispute.
   * The arbiter reviews evidence submitted by both parties and makes a final decision.
   *
   * The arbiter can rule:
   * - DisputeResolution.Complete (3): Funds go to seller (with 1% fee)
   * - DisputeResolution.Refunded (4): Funds go to buyer (no fee)
   *
   * Requirements:
   * - Both parties must have submitted evidence, OR
   * - 30 days + 1 hour timeout has passed since dispute started
   *
   * The arbiter's wallet signature is automatically generated for the multisig.
   *
   * @param walletClient - The arbiter's wallet client (must have account connected)
   * @param escrowId - The escrow ID to resolve
   * @param resolution - DisputeResolution.Complete or DisputeResolution.Refunded
   * @param ipfsHash - IPFS hash containing the decision explanation
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} NOT_ARBITER - If caller is not the designated arbiter
   * @throws {SDKError} INVALID_STATE - If escrow is not in DISPUTED state
   */
  async submitArbiterDecision(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    resolution: DisputeResolution,
    ipfsHash: string,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller using helper
    this.verifyArbiter(walletClient.account.address, deal);

    // Sign wallet authorization
    const arbiterWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Pre-validate signature before submitting transaction
    const isValidSig = await this.verifyWalletSignature(
      arbiterWalletSig,
      deal.wallet,
      escrowId,
      walletClient.account.address,
    );

    if (!isValidSig) {
      throw new SDKError(
        "Arbiter wallet signature is invalid - cannot submit decision",
        SDKErrorCode.SIGNATURE_INVALID,
      );
    }

    // Submit decision
    const hash = await this.resilientWriteContract(walletClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "submitArbiterDecision",
      args: [escrowId, resolution, ipfsHash, arbiterWalletSig],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // WALLET WITHDRAWAL
  // ==========================================================================

  /**
   * Withdraw funds from the escrow wallet
   *
   * This function executes the actual token transfer from the escrow wallet to the
   * designated recipient. The wallet contract uses a 2-of-3 multisig mechanism:
   *
   * - COMPLETE state: Requires buyer + seller signatures → funds go to seller
   * - REFUNDED state: Requires buyer + arbiter signatures → funds go to buyer
   * - CANCELED state: Requires buyer + seller signatures → funds go to buyer
   *
   * Anyone can call this function (typically the recipient), as the signatures
   * were already collected during the escrow lifecycle. The wallet contract
   * automatically reads and verifies signatures from the escrow contract.
   *
   * @param walletClient - Any wallet client (typically the recipient)
   * @param escrowId - The escrow ID to withdraw from
   * @returns Transaction hash
   * @throws {SDKError} WALLET_NOT_CONNECTED - If wallet client is not connected
   * @throws {SDKError} INVALID_STATE - If escrow is not in a final state (COMPLETE/REFUNDED/CANCELED)
   */
  async withdraw(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify final state
    if (![EscrowState.COMPLETE, EscrowState.REFUNDED, EscrowState.CANCELED].includes(deal.state)) {
      throw new SDKError(
        `Cannot withdraw in state: ${this.STATE_NAMES[deal.state]}`,
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Withdraw from wallet
    const hash = await this.resilientWriteContract(walletClient, {
      address: deal.wallet,
      abi: this.abiWallet,
      functionName: "withdraw",
      args: [],
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Get valid signature count for wallet
   */
  async getWalletSignatureCount(escrowId: bigint): Promise<number> {
    const deal = await this.getEscrowByIdParsed(escrowId);

    const count = await this.publicClient.readContract({
      address: deal.wallet,
      abi: this.abiWallet,
      functionName: "getValidSignatureCount",
    }) as bigint;

    return Number(count);
  }

  /**
   * Get wallet balance
   */
  async getWalletBalance(escrowId: bigint): Promise<bigint> {
    const deal = await this.getEscrowByIdParsed(escrowId);

    return this.publicClient.readContract({
      address: deal.wallet,
      abi: this.abiWallet,
      functionName: "getBalance",
    }) as Promise<bigint>;
  }

  // ==========================================================================
  // SUBGRAPH QUERIES
  // ==========================================================================

  async getEscrows(): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ALL_ESCROWS_QUERY,
      fetchPolicy: "network-only",
    });
    return data?.escrows ?? [];
  }

  async getEscrowsByBuyer(buyer: string): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_BUYER_QUERY,
      variables: { buyer: buyer.toLowerCase() },
      fetchPolicy: "network-only",
    });
    return data?.escrows ?? [];
  }

  async getEscrowsBySeller(seller: string): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_SELLER_QUERY,
      variables: { seller: seller.toLowerCase() },
      fetchPolicy: "network-only",
    });
    return data?.escrows ?? [];
  }

  async getEscrowDetail(escrowId: string | bigint): Promise<Escrow | undefined> {
    const id = typeof escrowId === 'bigint' ? escrowId.toString() : escrowId;
    const { data } = await this.apollo.query<{ escrow: Escrow }>({
      query: ESCROW_DETAIL_QUERY,
      variables: { id },
      fetchPolicy: "network-only",
    });
    return data?.escrow;
  }

  async getDisputeMessages(escrowId: string | bigint): Promise<DisputeMessage[]> {
    const id = typeof escrowId === 'bigint' ? escrowId.toString() : escrowId;
    const { data } = await this.apollo.query<{ escrow: { disputeMessages: DisputeMessage[] } }>({
      query: DISPUTE_MESSAGES_BY_ESCROW_QUERY,
      variables: { escrowId: id },
      fetchPolicy: "network-only",
    });
    return data?.escrow?.disputeMessages ?? [];
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  /**
   * Get a human-readable status label with color and description for an escrow state.
   * This is useful for displaying escrow status in UIs.
   *
   * @param state - The escrow state enum value
   * @returns An object containing:
   *   - label: Human-readable status name
   *   - color: Suggested UI color (orange, blue, red, green, gray)
   *   - description: Detailed explanation of what this state means
   *
   * @example
   * ```typescript
   * const sdk = new PalindromePaySDK(...);
   * const escrow = await sdk.getEscrowByIdParsed(1n);
   * const status = sdk.getStatusLabel(escrow.state);
   * console.log(status.label); // "Awaiting Payment"
   * console.log(status.color); // "orange"
   * console.log(status.description); // "Buyer needs to deposit funds"
   * ```
   */
  getStatusLabel(state: EscrowState): { label: string; color: string; description: string } {
    const labels: Record<EscrowState, { label: string; color: string; description: string }> = {
      [EscrowState.AWAITING_PAYMENT]: {
        label: "Awaiting Payment",
        color: "orange",
        description: "Buyer needs to deposit funds",
      },
      [EscrowState.AWAITING_DELIVERY]: {
        label: "Awaiting Delivery",
        color: "blue",
        description: "Seller should deliver product/service",
      },
      [EscrowState.DISPUTED]: {
        label: "Disputed",
        color: "red",
        description: "Dispute in progress - arbiter will resolve",
      },
      [EscrowState.COMPLETE]: {
        label: "Complete",
        color: "green",
        description: "Transaction completed successfully",
      },
      [EscrowState.REFUNDED]: {
        label: "Refunded",
        color: "gray",
        description: "Funds returned to buyer",
      },
      [EscrowState.CANCELED]: {
        label: "Canceled",
        color: "gray",
        description: "Escrow was canceled",
      },
    };
    return labels[state];
  }

  /**
   * Get user role for an escrow
   */
  getUserRole(userAddress: Address, escrow: EscrowData): Role {
    if (addressEquals(userAddress, escrow.buyer)) return Role.Buyer;
    if (addressEquals(userAddress, escrow.seller)) return Role.Seller;
    if (addressEquals(userAddress, escrow.arbiter)) return Role.Arbiter;
    return Role.None;
  }

  // ==========================================================================
  // SIMULATION & GAS ESTIMATION
  // ==========================================================================

  /**
   * Simulate a transaction before executing
   * Returns success status, gas estimate, and revert reason if failed
   */
  async simulateTransaction(
    walletClient: EscrowWalletClient,
    functionName: string,
    args: readonly unknown[],
    contractAddress?: Address,
  ): Promise<{
    success: boolean;
    gasEstimate?: bigint;
    revertReason?: string;
    result?: unknown;
  }> {
    assertWalletClient(walletClient);

    const target = contractAddress ?? this.contractAddress;

    try {
      // Simulate the call
      const { result } = await this.publicClient.simulateContract({
        address: target,
        abi: this.abiEscrow,
        functionName,
        args,
        account: walletClient.account,
      });

      // Estimate gas
      const gasEstimate = await this.publicClient.estimateContractGas({
        address: target,
        abi: this.abiEscrow,
        functionName,
        args,
        account: walletClient.account,
      });

      return {
        success: true,
        gasEstimate,
        result,
      };
    } catch (error: unknown) {
      // Extract revert reason
      let revertReason = "Unknown error";

      if (isViemError(error)) {
        if (error.cause?.reason) {
          revertReason = error.cause.reason;
        } else if (hasShortMessage(error)) {
          revertReason = error.shortMessage;
        } else if (error.message) {
          // Try to parse revert reason from error message
          const match = error.message.match(/reverted with reason string '([^']+)'/);
          if (match) {
            revertReason = match[1];
          } else {
            revertReason = error.message.slice(0, 200);
          }
        }
      }

      return {
        success: false,
        revertReason,
      };
    }
  }

  /**
   * Simulate deposit before executing
   */
  async simulateDeposit(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{
    success: boolean;
    gasEstimate?: bigint;
    revertReason?: string;
    needsApproval?: boolean;
    approvalAmount?: bigint;
  }> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Check approval first
    const allowance = await this.getTokenAllowance(
      walletClient.account.address,
      this.contractAddress,
      deal.token,
    );

    const needsApproval = allowance < deal.amount;

    // Simulate the deposit (without actual wallet sig for simulation)
    const result = await this.simulateTransaction(
      walletClient,
      "deposit",
      [escrowId, "0x" as Hex], // Empty sig for simulation
    );

    return {
      ...result,
      needsApproval,
      approvalAmount: needsApproval ? deal.amount - allowance : 0n,
    };
  }

  /**
   * Simulate confirm delivery before executing
   */
  async simulateConfirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{
    success: boolean;
    gasEstimate?: bigint;
    revertReason?: string;
  }> {
    return this.simulateTransaction(
      walletClient,
      "confirmDelivery",
      [escrowId, "0x" as Hex],
    );
  }

  /**
   * Simulate withdraw before executing
   */
  async simulateWithdraw(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<{
    success: boolean;
    gasEstimate?: bigint;
    revertReason?: string;
    signatureCount?: number;
  }> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);
    const signatureCount = await this.getWalletSignatureCount(escrowId);

    try {
      const gasEstimate = await this.publicClient.estimateContractGas({
        address: deal.wallet,
        abi: this.abiWallet,
        functionName: "withdraw",
        args: [],
        account: walletClient.account,
      });

      return {
        success: true,
        gasEstimate,
        signatureCount,
      };
    } catch (error: unknown) {
      let revertReason = "Unknown error";

      if (hasShortMessage(error)) {
        revertReason = error.shortMessage;
      } else if (isViemError(error)) {
        revertReason = error.message.slice(0, 200);
      }

      return {
        success: false,
        revertReason,
        signatureCount,
      };
    }
  }

  /**
   * Estimate gas for a transaction with buffer
   */
  async estimateGasWithBuffer(
    walletClient: EscrowWalletClient,
    functionName: string,
    args: readonly unknown[],
    contractAddress?: Address,
  ): Promise<bigint> {
    assertWalletClient(walletClient);

    const target = contractAddress ?? this.contractAddress;

    const gasEstimate = await this.publicClient.estimateContractGas({
      address: target,
      abi: this.abiEscrow,
      functionName,
      args,
      account: walletClient.account,
    });

    // Add buffer (default 20%)
    return gasEstimate + (gasEstimate * BigInt(this.gasBuffer)) / 100n;
  }

  // ==========================================================================
  // HEALTH CHECK
  // ==========================================================================

  /**
   * Health check
   */
  async healthCheck(): Promise<{
    rpcConnected: boolean;
    contractDeployed: boolean;
    subgraphConnected: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];
    let rpcConnected = false;
    let contractDeployed = false;
    let subgraphConnected = false;

    try {
      await this.publicClient.getBlockNumber();
      rpcConnected = true;
    } catch (e: unknown) {
      const message = this.extractErrorMessage(e);
      errors.push(`RPC error: ${message}`);
    }

    try {
      await this.getNextEscrowId();
      contractDeployed = true;
    } catch (e: unknown) {
      const message = this.extractErrorMessage(e);
      errors.push(`Contract error: ${message}`);
    }

    try {
      await this.getEscrows();
      subgraphConnected = true;
    } catch (e: unknown) {
      const message = this.extractErrorMessage(e);
      errors.push(`Subgraph error: ${message}`);
    }

    return { rpcConnected, contractDeployed, subgraphConnected, errors };
  }

  // ==========================================================================
  // CACHE MANAGEMENT
  // ==========================================================================

  /**
   * Get escrow status with optional caching
   */
  async getEscrowStatus(
    escrowId: bigint,
    forceRefresh = false,
  ): Promise<{
    state: EscrowState;
    stateName: string;
    label: string;
    color: string;
    description: string;
  }> {
    const cacheKey = `status-${escrowId}`;

    if (!forceRefresh) {
      const cached = this.getCacheValue<{
        state: EscrowState;
        stateName: string;
        label: string;
        color: string;
        description: string;
      }>(cacheKey);
      if (cached) return cached;
    }

    const deal = await this.getEscrowByIdParsed(escrowId);
    const statusInfo = this.getStatusLabel(deal.state);

    const result = {
      state: deal.state,
      stateName: this.STATE_NAMES[deal.state],
      ...statusInfo,
    };

    this.setCacheValue(cacheKey, result);
    return result;
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    escrowCacheSize: number;
    tokenDecimalsCacheSize: number;
  } {
    return {
      escrowCacheSize: this.escrowCache.size,
      tokenDecimalsCacheSize: this.tokenDecimalsCache.size,
    };
  }

  /**
   * Clear the Apollo cache. Call this when switching wallets to prevent
   * "Store error: database unavailable" errors.
   */
  async clearApolloCache(): Promise<void> {
    try {
      await this.apollo.clearStore();
    } catch (error) {
      // If clearStore fails, reset the client entirely
      this.apollo.stop();
      await this.apollo.resetStore();
    }
  }

  /**
   * Clear all caches including Apollo cache. Call when switching wallets.
   */
  async clearAllCaches(): Promise<void> {
    this.escrowCache.clear();
    this.tokenDecimalsCache.clear();
    this.feeReceiverCache = null;
    this.cachedFeeBps = null;
    this.multicallSupported = null;
    await this.clearApolloCache();
  }

  /**
   * Clear escrow cache only
   */
  clearEscrowCache(): void {
    this.escrowCache.clear();
  }

  /**
   * Clear multicall cache (useful when switching chains)
   */
  clearMulticallCache(): void {
    this.multicallSupported = null;
  }

  // ==========================================================================
  // EVENT WATCHING
  // ==========================================================================

  /**
   * Watch for escrow events related to a user
   */
  watchUserEscrows(
    userAddress: Address,
    callback: (escrowId: bigint, event: EscrowCreatedEvent) => void,
    options?: { fromBlock?: bigint },
  ): { dispose: () => void } {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: "EscrowCreated",
      fromBlock: options?.fromBlock,
      onLogs: (logs) => {
        for (const log of logs) {
          type ParsedLog = {
            args?: EscrowCreatedEvent;
          };

          const parsedLog = log as unknown as ParsedLog;
          if (!parsedLog.args) {
            continue; // Skip logs without args
          }
          const args = parsedLog.args;

          if (
            addressEquals(args.buyer, userAddress) ||
            addressEquals(args.seller, userAddress)
          ) {
            callback(args.escrowId, args);
          }
        }
      },
    });

    return { dispose: unwatch };
  }

  /**
   * Watch for state changes on a specific escrow
   */
  watchEscrowStateChanges(
    escrowId: bigint,
    callback: (newState: EscrowState, previousState: EscrowState) => void,
    options?: { pollingInterval?: number },
  ): { dispose: () => void } {
    let lastState: EscrowState | null = null;
    const interval = options?.pollingInterval ?? DEFAULT_POLLING_INTERVAL;

    const poll = async () => {
      try {
        const deal = await this.getEscrowByIdParsed(escrowId);
        if (lastState !== null && deal.state !== lastState) {
          callback(deal.state, lastState);
        }
        lastState = deal.state;
      } catch (e: unknown) {
        const message = this.extractErrorMessage(e);
        this.log('error', 'Error polling escrow state', {
          escrowId: escrowId.toString(),
          error: message
        });
      }
    };

    // Initial poll
    poll();

    // Set up interval
    const intervalId = setInterval(poll, interval);

    return {
      dispose: () => clearInterval(intervalId),
    };
  }

  // ==========================================================================
  // ADDITIONAL HELPERS
  // ==========================================================================

  /**
   * Check if user has submitted evidence for a dispute
   */
  async hasSubmittedEvidence(escrowId: bigint, role: Role): Promise<boolean> {
    const status = await this.getDisputeSubmissionStatus(escrowId);

    switch (role) {
      case Role.Buyer:
        return status.buyer;
      case Role.Seller:
        return status.seller;
      case Role.Arbiter:
        return status.arbiter;
      default:
        return false;
    }
  }

  /**
   * Get cancellation request status for an escrow
   *
   * This helper function checks whether the buyer and/or seller have requested
   * cancellation. Use this to determine if mutual cancellation is pending or complete.
   *
   * Cancellation flow:
   * - Either party calls `requestCancel` to initiate
   * - If only one party requested, the other must also call `requestCancel` for mutual cancel
   * - When both request, the escrow is automatically canceled and funds return to buyer
   * - Alternatively, buyer can use `cancelByTimeout` after maturity time (if arbiter is set)
   *
   * @param escrowId - The escrow ID to check
   * @returns Object with buyer/seller cancel request status and whether mutual cancel is complete
   */
  async getCancelRequestStatus(escrowId: bigint): Promise<{
    buyerRequested: boolean;
    sellerRequested: boolean;
    mutualCancelComplete: boolean;
  }> {
    const deal = await this.getEscrowByIdParsed(escrowId);

    return {
      buyerRequested: deal.buyerCancelRequested,
      sellerRequested: deal.sellerCancelRequested,
      mutualCancelComplete: deal.buyerCancelRequested && deal.sellerCancelRequested,
    };
  }

  /**
   * Get user balances for multiple tokens (batched for performance).
   * Uses Promise.all to fetch all balances and decimals in parallel.
   */
  async getUserBalances(
    userAddress: Address,
    tokens: Address[],
  ): Promise<Map<Address, { balance: bigint; decimals: number; formatted: string }>> {
    if (tokens.length === 0) {
      return new Map();
    }

    // Batch fetch all balances and decimals in parallel
    const [balances, decimalsArray] = await Promise.all([
      Promise.all(tokens.map((token) => this.getTokenBalance(userAddress, token))),
      Promise.all(tokens.map((token) => this.getTokenDecimals(token))),
    ]);

    const result = new Map<Address, { balance: bigint; decimals: number; formatted: string }>();

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const balance = balances[i];
      const decimals = decimalsArray[i];
      const formatted = this.formatTokenAmount(balance, decimals);

      result.set(token, { balance, decimals, formatted });
    }

    return result;
  }

  /**
   * Get maturity info for an escrow
   */
  getMaturityInfo(
    depositTime: bigint,
    maturityDays: bigint,
  ): {
    hasDeadline: boolean;
    maturityDays: number;
    maturityTimestamp: bigint;
    isPassed: boolean;
    remainingSeconds: number;
  } {
    const hasDeadline = maturityDays > 0n;
    const maturityTimestamp = depositTime + maturityDays * 86400n;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const isPassed = now >= maturityTimestamp;
    const remainingSeconds = isPassed ? 0 : Number(maturityTimestamp - now);

    return {
      hasDeadline,
      maturityDays: Number(maturityDays),
      maturityTimestamp,
      isPassed,
      remainingSeconds,
    };
  }

  /**
   * Get all escrows for a user (as buyer or seller)
   */
  async getUserEscrows(userAddress: Address): Promise<Escrow[]> {
    const [buyerEscrows, sellerEscrows] = await Promise.all([
      this.getEscrowsByBuyer(userAddress),
      this.getEscrowsBySeller(userAddress),
    ]);

    // Merge and deduplicate by ID
    const escrowMap = new Map<string, Escrow>();
    for (const escrow of [...buyerEscrows, ...sellerEscrows]) {
      escrowMap.set(escrow.id, escrow);
    }

    return Array.from(escrowMap.values());
  }

  // ============================================================================
  // STATE & ROLE VALIDATION HELPERS
  // ============================================================================

  /**
   * Check if a user can deposit to an escrow.
   * A user can deposit if:
   * - The escrow exists and is in AWAITING_PAYMENT state
   * - The user is either the buyer or seller
   *
   * @param userAddress - The address of the user to check
   * @param escrowId - The escrow ID to check
   * @returns True if the user can deposit, false otherwise
   */
  async canUserDeposit(userAddress: Address, escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be in AWAITING_PAYMENT state
      if (escrow.state !== EscrowState.AWAITING_PAYMENT) {
        return false;
      }

      // Must be buyer or seller
      return addressEquals(userAddress, escrow.buyer) ||
        addressEquals(userAddress, escrow.seller);
    } catch {
      return false;
    }
  }

  /**
   * Check if a user can accept an escrow (seller accepting after buyer deposit).
   * A user can accept if:
   * - The escrow is in AWAITING_DELIVERY state
   * - The user is the seller
   *
   * @param userAddress - The address of the user to check
   * @param escrowId - The escrow ID to check
   * @returns True if the user can accept, false otherwise
   */
  async canUserAcceptEscrow(userAddress: Address, escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be in AWAITING_DELIVERY state
      if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
        return false;
      }

      // Must be seller
      return addressEquals(userAddress, escrow.seller);
    } catch {
      return false;
    }
  }

  /**
   * Check if a user can confirm delivery (buyer confirming receipt).
   * A user can confirm delivery if:
   * - The escrow is in AWAITING_DELIVERY or DISPUTED state
   * - The user is the buyer
   *
   * @param userAddress - The address of the user to check
   * @param escrowId - The escrow ID to check
   * @returns True if the user can confirm delivery, false otherwise
   */
  async canUserConfirmDelivery(userAddress: Address, escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be in AWAITING_DELIVERY or DISPUTED state
      if (escrow.state !== EscrowState.AWAITING_DELIVERY &&
        escrow.state !== EscrowState.DISPUTED) {
        return false;
      }

      // Must be buyer
      return addressEquals(userAddress, escrow.buyer);
    } catch {
      return false;
    }
  }

  /**
   * Check if a user can start a dispute.
   * A user can start a dispute if:
   * - The escrow is in AWAITING_DELIVERY state
   * - The escrow has an arbiter set
   * - The user is either the buyer or seller
   *
   * @param userAddress - The address of the user to check
   * @param escrowId - The escrow ID to check
   * @returns True if the user can start a dispute, false otherwise
   */
  async canUserStartDispute(userAddress: Address, escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be in AWAITING_DELIVERY state
      if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
        return false;
      }

      // Must have arbiter
      if (!this.hasArbiter(escrow)) {
        return false;
      }

      // Must be buyer or seller
      return addressEquals(userAddress, escrow.buyer) ||
        addressEquals(userAddress, escrow.seller);
    } catch {
      return false;
    }
  }

  /**
   * Check if an escrow can be withdrawn (auto-release check).
   * An escrow can be withdrawn if:
   * - It's in AWAITING_DELIVERY state
   * - The maturity time has passed (if deadline is set)
   *
   * @param escrowId - The escrow ID to check
   * @returns True if the escrow can be withdrawn, false otherwise
   */
  async canUserWithdraw(escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be in AWAITING_DELIVERY state
      if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
        return false;
      }

      // Check if maturity time has passed (if deadline is set)
      if (escrow.maturityTime > 0n) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        return now >= escrow.maturityTime;
      }

      // No deadline set, cannot auto-withdraw
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if a seller can perform auto-release.
   * A seller can auto-release if:
   * - The escrow is in AWAITING_DELIVERY state
   * - The maturity time has passed (if deadline is set)
   * - The user is the seller
   *
   * @param userAddress - The address of the user to check
   * @param escrowId - The escrow ID to check
   * @returns True if the seller can auto-release, false otherwise
   */
  async canSellerAutoRelease(userAddress: Address, escrowId: bigint): Promise<boolean> {
    try {
      const escrow = await this.getEscrowByIdParsed(escrowId);

      // Must be seller
      if (!addressEquals(userAddress, escrow.seller)) {
        return false;
      }

      // Must be in AWAITING_DELIVERY state
      if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
        return false;
      }

      // Check if maturity time has passed (if deadline is set)
      if (escrow.maturityTime > 0n) {
        const now = BigInt(Math.floor(Date.now() / 1000));
        return now >= escrow.maturityTime;
      }

      // No deadline set, cannot auto-release
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Check if an address is the buyer in an escrow.
   *
   * @param userAddress - The address to check
   * @param escrow - The escrow data
   * @returns True if the address is the buyer
   */
  isBuyer(userAddress: Address, escrow: EscrowData): boolean {
    return addressEquals(userAddress, escrow.buyer);
  }

  /**
   * Check if an address is the seller in an escrow.
   *
   * @param userAddress - The address to check
   * @param escrow - The escrow data
   * @returns True if the address is the seller
   */
  isSeller(userAddress: Address, escrow: EscrowData): boolean {
    return addressEquals(userAddress, escrow.seller);
  }

  /**
   * Check if an address is the arbiter in an escrow.
   *
   * @param userAddress - The address to check
   * @param escrow - The escrow data
   * @returns True if the address is the arbiter
   */
  isArbiter(userAddress: Address, escrow: EscrowData): boolean {
    return addressEquals(userAddress, escrow.arbiter);
  }

  /**
   * Check if an escrow has an arbiter set.
   *
   * @param escrow - The escrow data
   * @returns True if the escrow has an arbiter (non-zero address)
   */
  hasArbiter(escrow: EscrowData): boolean {
    return escrow.arbiter !== zeroAddress;
  }

  /**
   * Compare two addresses for equality (case-insensitive, normalized).
   * This is a public utility method that can be used to compare Ethereum addresses.
   *
   * @param a - First address to compare
   * @param b - Second address to compare
   * @returns True if the addresses are equal (case-insensitive)
   *
   * @example
   * ```typescript
   * const sdk = new PalindromePaySDK(...);
   * const areEqual = sdk.addressEquals(
   *   "0xabc...",
   *   "0xABC..."
   * ); // true
   * ```
   */
  addressEquals(a: Address | string, b: Address | string): boolean {
    return addressEquals(a, b);
  }

  // ============================================================================
  // GAS ESTIMATION HELPERS
  // ============================================================================

  /**
   * Get current gas price information from the network.
   * Returns standard, fast, and instant gas price estimates in gwei.
   *
   * @returns Object containing gas price estimates
   *
   * @example
   * ```typescript
   * const gasPrice = await sdk.getCurrentGasPrice();
   * console.log(`Standard: ${gasPrice.standard} gwei`);
   * console.log(`Fast: ${gasPrice.fast} gwei`);
   * console.log(`Instant: ${gasPrice.instant} gwei`);
   * ```
   */
  async getCurrentGasPrice(): Promise<{
    standard: bigint;
    fast: bigint;
    instant: bigint;
    wei: bigint;
  }> {
    const gasPrice = await this.publicClient.getGasPrice();

    // Estimate different speed tiers (standard, fast, instant)
    // Standard: base price
    // Fast: +20%
    // Instant: +50%
    const standard = gasPrice;
    const fast = (gasPrice * 120n) / 100n;
    const instant = (gasPrice * 150n) / 100n;

    return {
      standard,
      fast,
      instant,
      wei: gasPrice
    };
  }

  /**
   * Estimate gas cost for creating an escrow.
   *
   * @param params - Create escrow parameters
   * @returns Gas estimation details
   *
   * @example
   * ```typescript
   * const estimate = await sdk.estimateGasForCreateEscrow({
   *   token: tokenAddress,
   *   buyer: buyerAddress,
   *   amount: 1000000n,
   *   maturityDays: 7n,
   *   arbiter: zeroAddress,
   *   title: 'Test',
   *   ipfsHash: ''
   * });
   * console.log(`Gas limit: ${estimate.gasLimit}`);
   * console.log(`Cost: ${estimate.estimatedCostEth} ETH`);
   * ```
   */
  async estimateGasForCreateEscrow(params: {
    token: Address;
    buyer: Address;
    amount: bigint;
    maturityDays: bigint;
    arbiter: Address;
    title: string;
    ipfsHash: string;
  }): Promise<{
    gasLimit: bigint;
    estimatedCostWei: bigint;
    estimatedCostEth: string;
  }> {
    if (!this.walletClient) {
      throw new Error('Wallet client required for gas estimation');
    }

    try {
      const gasLimit = await this.publicClient.estimateContractGas({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: 'createEscrow',
        args: [
          params.token,
          params.buyer,
          params.amount,
          params.maturityDays,
          params.arbiter,
          params.title,
          params.ipfsHash,
          pad('0x00', { size: 65 }) // Empty seller wallet sig
        ],
        account: this.walletClient.account
      });

      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    } catch (error: unknown) {
      // If estimation fails, return conservative estimate
      const gasLimit = 300000n; // Conservative estimate
      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    }
  }

  /**
   * Estimate gas cost for depositing to an escrow.
   *
   * @param escrowId - The escrow ID
   * @returns Gas estimation details
   *
   * @example
   * ```typescript
   * const estimate = await sdk.estimateGasForDeposit(escrowId);
   * console.log(`Gas limit: ${estimate.gasLimit}`);
   * ```
   */
  async estimateGasForDeposit(escrowId: bigint): Promise<{
    gasLimit: bigint;
    estimatedCostWei: bigint;
    estimatedCostEth: string;
  }> {
    if (!this.walletClient) {
      throw new Error('Wallet client required for gas estimation');
    }

    try {
      const gasLimit = await this.publicClient.estimateContractGas({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: 'deposit',
        args: [escrowId, pad('0x00', { size: 65 })],
        account: this.walletClient.account
      });

      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    } catch {
      const gasLimit = 200000n;
      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    }
  }

  /**
   * Estimate gas cost for confirming delivery.
   *
   * @param escrowId - The escrow ID
   * @returns Gas estimation details
   *
   * @example
   * ```typescript
   * const estimate = await sdk.estimateGasForConfirmDelivery(escrowId);
   * console.log(`Cost: ${estimate.estimatedCostEth} ETH`);
   * ```
   */
  async estimateGasForConfirmDelivery(escrowId: bigint): Promise<{
    gasLimit: bigint;
    estimatedCostWei: bigint;
    estimatedCostEth: string;
  }> {
    if (!this.walletClient) {
      throw new Error('Wallet client required for gas estimation');
    }

    try {
      const gasLimit = await this.publicClient.estimateContractGas({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: 'confirmDelivery',
        args: [escrowId, pad('0x00', { size: 65 })],
        account: this.walletClient.account
      });

      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    } catch {
      const gasLimit = 150000n;
      const gasPrice = await this.publicClient.getGasPrice();
      const estimatedCostWei = gasLimit * gasPrice;
      const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

      return {
        gasLimit,
        estimatedCostWei,
        estimatedCostEth
      };
    }
  }

  /**
   * Estimate gas cost for withdrawing from escrow wallet.
   *
   * @returns Gas estimation details
   *
   * @example
   * ```typescript
   * const estimate = await sdk.estimateGasForWithdraw();
   * ```
   */
  async estimateGasForWithdraw(): Promise<{
    gasLimit: bigint;
    estimatedCostWei: bigint;
    estimatedCostEth: string;
  }> {
    const gasLimit = 100000n; // Withdraw is typically cheaper
    const gasPrice = await this.publicClient.getGasPrice();
    const estimatedCostWei = gasLimit * gasPrice;
    const estimatedCostEth = (Number(estimatedCostWei) / 1e18).toFixed(6);

    return {
      gasLimit,
      estimatedCostWei,
      estimatedCostEth
    };
  }

  // ============================================================================
  // FEE UTILITIES
  // ============================================================================

  /**
   * Get fee receiver address (cached - rarely changes)
   * @param forceRefresh - Set to true to bypass cache and fetch fresh value
   */
  async getFeeReceiver(forceRefresh = false): Promise<Address> {
    if (!forceRefresh && this.feeReceiverCache) {
      return this.feeReceiverCache;
    }

    this.feeReceiverCache = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "feeReceiver",
    }) as Address;

    return this.feeReceiverCache;
  }

  /** Cached fee basis points (lazily computed from contract) */
  private cachedFeeBps: bigint | null = null;

  /**
   * Get fee percentage in basis points.
   * Tries to read FEE_BPS from contract, falls back to default (100 = 1%).
   * Result is cached for performance.
   */
  async getFeeBps(): Promise<bigint> {
    if (this.cachedFeeBps !== null) {
      return this.cachedFeeBps;
    }

    try {
      // Try to read FEE_BPS if it's public in the contract
      const feeBps = await this.publicClient.readContract({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: "FEE_BPS",
      }) as bigint;
      this.cachedFeeBps = feeBps;
      return feeBps;
    } catch (e: unknown) {
      // Fall back to default if not readable (private constant)
      const message = this.extractErrorMessage(e);
      this.log('warn', 'Could not read FEE_BPS from contract, using default', {
        error: message
      });
      this.cachedFeeBps = 100n; // 1% fee
      return this.cachedFeeBps;
    }
  }

  /**
   * Calculate fee for an amount.
   * Uses the same logic as the contract's _computeFeeAndNet.
   */
  async calculateFee(amount: bigint, tokenDecimals: number = 6): Promise<{ fee: bigint; net: bigint }> {
    const feeBps = await this.getFeeBps();
    const minFee = 10n ** BigInt(tokenDecimals > 2 ? tokenDecimals - 2 : 0);
    const calculatedFee = (amount * feeBps) / 10000n;
    const fee = calculatedFee >= minFee ? calculatedFee : minFee;
    return { fee, net: amount - fee };
  }
}

// ============================================================================
// EXPORT DEFAULT
// ============================================================================

export default PalindromePaySDK;