// Copyright (c) 2025 Palindrome Finance
// Licensed under the MIT License. See LICENSE file for details.

/**
 * PALINDROME CRYPTO ESCROW SDK
 * 
 * Corrected and optimized SDK matching the actual smart contract interfaces.
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
  decodeAbiParameters,
  parseEventLogs,
  Transport,
  Account,
  Chain,
  keccak256,
  pad,
  toBytes,
  encodeAbiParameters,
  getAddress,
} from "viem";
import { readContract } from "viem/actions";
import PalindromeCryptoEscrowABI from "./contract/PalindromeCryptoEscrow.json";
import PalindromeEscrowWalletABI from "./contract/PalindromeEscrowWallet.json";
import ERC20ABI from "./contract/USDT.json";
import { ApolloClient, InMemoryCache, HttpLink, NormalizedCacheObject } from "@apollo/client";
import {
  ALL_ESCROWS_QUERY,
  DISPUTE_MESSAGES_BY_ESCROW_QUERY,
  ESCROWS_BY_BUYER_QUERY,
  ESCROWS_BY_SELLER_QUERY,
  ESCROW_DETAIL_QUERY,
} from "./subgraph/queries";
import { Escrow } from "./types/escrow";
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
}

export type EscrowWalletClient = WalletClient<Transport, Chain, Account>;

export class SDKError extends Error {
  code: SDKErrorCode;
  details?: any;

  constructor(message: string, code: SDKErrorCode, details?: any) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "SDKError";
  }
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface PalindromeEscrowSDKConfig {
  publicClient: PublicClient;
  contractAddress: Address;
  walletClient?: EscrowWalletClient;
  apolloClient?: ApolloClient;
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
  subgraphUrl?: string;
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
  return address === "0x0000000000000000000000000000000000000000";
}

/**
 * Validate signature format (65 bytes = 130 hex chars + 0x prefix)
 */
function validateSignature(signature: Hex, context: string = "signature"): void {
  if (!signature.startsWith("0x") || signature.length !== 132) {
    throw new SDKError(
      `Invalid ${context} format: expected 65-byte signature`,
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

export class PalindromeEscrowSDK {
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

  /** LRU cache for escrow data with automatic eviction */
  private escrowCache: Map<string, { data: any; timestamp: number }> = new Map();
  /** Cache for token decimals (rarely changes, no eviction needed) */
  private tokenDecimalsCache: Map<Address, number> = new Map();

  private readonly STATE_NAMES = [
    "AWAITING_PAYMENT",
    "AWAITING_DELIVERY",
    "DISPUTED",
    "COMPLETE",
    "REFUNDED",
    "CANCELED",
  ] as const;

  constructor(config: PalindromeEscrowSDKConfig) {
    if (!config.contractAddress) {
      throw new SDKError("contractAddress is required", SDKErrorCode.VALIDATION_ERROR);
    }

    this.contractAddress = config.contractAddress;
    this.abiEscrow = PalindromeCryptoEscrowABI.abi as Abi;
    this.abiWallet = PalindromeEscrowWalletABI.abi as Abi;
    this.abiERC20 = ERC20ABI.abi as Abi;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.chain = config.chain ?? hardhat;
    this.cacheTTL = config.cacheTTL ?? 5000;
    this.maxCacheSize = config.maxCacheSize ?? 1000;
    this.enableRetry = config.enableRetry ?? true;
    this.maxRetries = config.maxRetries ?? 3;
    this.retryDelay = config.retryDelay ?? 1000;
    this.gasBuffer = config.gasBuffer ?? 20;
    this.receiptTimeout = config.receiptTimeout ?? 60000;

    this.apollo = config.apolloClient ?? new ApolloClient({
      link: new HttpLink({
        uri: config.subgraphUrl ?? "https://api.studio.thegraph.com/query/121986/palindrome-finance-subgraph/version/latest",
      }),
      cache: new InMemoryCache(),
    });
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  /**
   * Wait for transaction receipt with timeout and retry logic.
   */
  private async waitForReceipt(hash: Hex): Promise<any> {
    return this.withRetry(async () => {
      return this.publicClient.waitForTransactionReceipt({
        hash,
        timeout: this.receiptTimeout,
      });
    }, "waitForTransactionReceipt");
  }

  /**
   * Execute an async operation with retry logic.
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string = "operation",
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;

        // Don't retry on validation errors or user rejections
        if (
          error?.code === SDKErrorCode.VALIDATION_ERROR ||
          error?.code === 4001 || // User rejected
          error?.name === "SDKError"
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
   * Set a value in the LRU cache with automatic eviction.
   */
  private setCacheValue(key: string, data: any): void {
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
      name: "PalindromeEscrowWallet",
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
   */
  async predictWalletAddress(escrowId: bigint): Promise<Address> {
    const salt = keccak256(pad(toBytes(escrowId), { size: 32 }));

    // Get wallet bytecode hash from contract
    const walletBytecodeHash = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "WALLET_BYTECODE_HASH",
    }) as Hex;

    // Compute CREATE2 address
    const encodedArgs = encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }],
      [this.contractAddress, escrowId],
    );

    // Note: For accurate prediction, need actual bytecode + args hash
    // This is a simplified version - in production, use the contract's computation
    const initCodeHash = keccak256(
      (PalindromeEscrowWalletABI.bytecode + encodedArgs.slice(2)) as Hex
    );

    const raw = keccak256(
      (`0xff${this.contractAddress.slice(2)}${salt.slice(2)}${initCodeHash.slice(2)}`) as Hex
    );

    return getAddress(`0x${raw.slice(26)}`);
  }

  // ==========================================================================
  // ESCROW DATA READING
  // ==========================================================================

  /**
   * Get raw escrow data from contract
   */
  async getEscrowById(escrowId: bigint): Promise<any> {
    return readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getEscrow",
      args: [escrowId],
    });
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
   * Each bitmap word contains 256 nonce states. A set bit means the nonce is used.
   * 
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param wordIndex - The word index (nonce / 256)
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

    while (wordIndex < PalindromeEscrowSDK.MAX_NONCE_WORDS) {
      const bitmap = await this.getNonceBitmap(escrowId, signer, wordIndex);

      // If bitmap is all 1s (all 256 nonces used), check next word
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
   * Get multiple available nonces at once (for batch operations).
   *
   * @param escrowId - The escrow ID
   * @param signer - The signer's address
   * @param count - Number of nonces to retrieve (max 256)
   * @returns Array of available nonces
   * @throws SDKError if count exceeds limit or nonce space is exhausted
   */
  async getMultipleNonces(escrowId: bigint, signer: Address, count: number): Promise<bigint[]> {
    // Limit count to prevent excessive RPC calls
    const MAX_NONCES_PER_REQUEST = 256;
    if (count > MAX_NONCES_PER_REQUEST) {
      throw new SDKError(
        `Cannot request more than ${MAX_NONCES_PER_REQUEST} nonces at once`,
        SDKErrorCode.VALIDATION_ERROR,
      );
    }
    if (count <= 0) {
      return [];
    }

    const nonces: bigint[] = [];
    let wordIndex = 0n;

    while (nonces.length < count && wordIndex < PalindromeEscrowSDK.MAX_NONCE_WORDS) {
      const bitmap = await this.getNonceBitmap(escrowId, signer, wordIndex);

      for (let i = 0n; i < 256n && nonces.length < count; i++) {
        if ((bitmap & (1n << i)) === 0n) {
          nonces.push(wordIndex * 256n + i);
        }
      }

      wordIndex++;
    }

    if (nonces.length < count) {
      throw new SDKError(
        `Only found ${nonces.length} available nonces, requested ${count}`,
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

    const hash = await walletClient.writeContract({
      address: token,
      abi: this.abiERC20,
      functionName: "approve",
      args: [spender, amount],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // ESCROW CREATION
  // ==========================================================================

  /**
   * Create escrow (called by SELLER)
   * Contract: createEscrow(token, buyer, amount, maturityDays, arbiter, title, ipfsHash, sellerWalletSig)
   */
  async createEscrow(
    walletClient: EscrowWalletClient,
    params: CreateEscrowParams,
  ): Promise<{ escrowId: bigint; txHash: Hex; walletAddress: Address }> {
    assertWalletClient(walletClient);

    // Validate and normalize addresses
    const token = validateAddress(params.token, "token");
    const buyer = validateAddress(params.buyer, "buyer");
    const arbiter = params.arbiter
      ? validateAddress(params.arbiter, "arbiter")
      : "0x0000000000000000000000000000000000000000" as Address;

    // Validate amount
    if (params.amount <= 0n) {
      throw new SDKError("Amount must be greater than 0", SDKErrorCode.VALIDATION_ERROR);
    }

    // Validate title
    if (!params.title || params.title.length === 0) {
      throw new SDKError("Title is required", SDKErrorCode.VALIDATION_ERROR);
    }
    if (params.title.length > 256) {
      throw new SDKError("Title must be 256 characters or less", SDKErrorCode.VALIDATION_ERROR);
    }

    // Validate arbiter is not buyer or seller
    const sellerAddress = walletClient.account.address;
    if (!isZeroAddress(arbiter)) {
      if (getAddress(arbiter) === getAddress(buyer)) {
        throw new SDKError("Arbiter cannot be the buyer", SDKErrorCode.VALIDATION_ERROR);
      }
      if (getAddress(arbiter) === getAddress(sellerAddress)) {
        throw new SDKError("Arbiter cannot be the seller", SDKErrorCode.VALIDATION_ERROR);
      }
    }

    const maturityDays = params.maturityTimeDays ?? 0n;
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

    // Create escrow
    const hash = await walletClient.writeContract({
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
      account: walletClient.account,
      chain: this.chain,
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

    return { escrowId, txHash: hash, walletAddress: deal.wallet };
  }

  /**
   * Create escrow and deposit (called by BUYER)
   * Contract: createEscrowAndDeposit(token, seller, amount, maturityDays, arbiter, title, ipfsHash, buyerWalletSig)
   */
  async createEscrowAndDeposit(
    walletClient: EscrowWalletClient,
    params: CreateEscrowAndDepositParams,
  ): Promise<{ escrowId: bigint; txHash: Hex; walletAddress: Address }> {
    assertWalletClient(walletClient);

    // Validate and normalize addresses
    const token = validateAddress(params.token, "token");
    const seller = validateAddress(params.seller, "seller");
    const arbiter = params.arbiter
      ? validateAddress(params.arbiter, "arbiter")
      : "0x0000000000000000000000000000000000000000" as Address;

    // Validate amount
    if (params.amount <= 0n) {
      throw new SDKError("Amount must be greater than 0", SDKErrorCode.VALIDATION_ERROR);
    }

    // Validate title
    if (!params.title || params.title.length === 0) {
      throw new SDKError("Title is required", SDKErrorCode.VALIDATION_ERROR);
    }
    if (params.title.length > 256) {
      throw new SDKError("Title must be 256 characters or less", SDKErrorCode.VALIDATION_ERROR);
    }

    // Validate arbiter is not buyer or seller
    const buyerAddress = walletClient.account.address;
    if (!isZeroAddress(arbiter)) {
      if (getAddress(arbiter) === getAddress(seller)) {
        throw new SDKError("Arbiter cannot be the seller", SDKErrorCode.VALIDATION_ERROR);
      }
      if (getAddress(arbiter) === getAddress(buyerAddress)) {
        throw new SDKError("Arbiter cannot be the buyer", SDKErrorCode.VALIDATION_ERROR);
      }
    }

    const maturityDays = params.maturityTimeDays ?? 0n;
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

    // Create escrow and deposit
    const hash = await walletClient.writeContract({
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
      account: walletClient.account,
      chain: this.chain,
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

    return { escrowId, txHash: hash, walletAddress: deal.wallet };
  }

  // ==========================================================================
  // DEPOSIT
  // ==========================================================================

  /**
   * Deposit funds into escrow (called by BUYER)
   * Contract: deposit(escrowId, buyerWalletSig)
   */
  async deposit(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller is buyer
    if (!addressEquals(walletClient.account.address, deal.buyer)) {
      throw new SDKError("Only buyer can deposit", SDKErrorCode.NOT_BUYER);
    }

    // Verify state
    if (deal.state !== EscrowState.AWAITING_PAYMENT) {
      throw new SDKError(
        `Invalid state: ${this.STATE_NAMES[deal.state]}. Expected: AWAITING_PAYMENT`,
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Approve token spending
    await this.approveTokenIfNeeded(
      walletClient,
      deal.token,
      this.contractAddress,
      deal.amount,
    );

    // Sign wallet authorization
    const buyerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Deposit
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "deposit",
      args: [escrowId, buyerWalletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // ACCEPT ESCROW (for buyer-created escrows)
  // ==========================================================================

  /**
   * Accept escrow (called by SELLER when buyer created the escrow)
   * Contract: acceptEscrow(escrowId, sellerWalletSig)
   */
  async acceptEscrow(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller is seller
    if (!addressEquals(walletClient.account.address, deal.seller)) {
      throw new SDKError("Only seller can accept", SDKErrorCode.NOT_SELLER);
    }

    // Verify state
    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new SDKError(
        `Invalid state: ${this.STATE_NAMES[deal.state]}. Expected: AWAITING_DELIVERY`,
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Check if already accepted (seller sig already exists)
    if (deal.sellerWalletSig && deal.sellerWalletSig !== "0x") {
      throw new SDKError("Escrow already accepted", SDKErrorCode.ALREADY_ACCEPTED);
    }

    // Sign wallet authorization
    const sellerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Accept escrow
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "acceptEscrow",
      args: [escrowId, sellerWalletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // CONFIRM DELIVERY
  // ==========================================================================

  /**
   * Confirm delivery (called by BUYER)
   * Contract: confirmDelivery(escrowId, buyerWalletSig)
   */
  async confirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller is buyer
    if (!addressEquals(walletClient.account.address, deal.buyer)) {
      throw new SDKError("Only buyer can confirm delivery", SDKErrorCode.NOT_BUYER);
    }

    // Verify state
    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new SDKError(
        `Invalid state: ${this.STATE_NAMES[deal.state]}. Expected: AWAITING_DELIVERY`,
        SDKErrorCode.INVALID_STATE,
      );
    }

    // Sign wallet authorization
    const buyerWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Confirm delivery
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "confirmDelivery",
      args: [escrowId, buyerWalletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Confirm delivery with signature (gasless for buyer, relayer pays gas)
   * Contract: confirmDeliverySigned(escrowId, coordSignature, deadline, nonce, buyerWalletSig)
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
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "confirmDeliverySigned",
      args: [escrowId, coordSignature, deadline, nonce, buyerWalletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Helper: Buyer signs and generates all data for gasless confirm delivery
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

    // Verify caller is buyer
    if (!addressEquals(buyerWalletClient.account.address, deal.buyer)) {
      throw new SDKError("Only buyer can sign", SDKErrorCode.NOT_BUYER);
    }

    const deadline = await this.createSignatureDeadline(60); // 60 minutes
    const nonce = await this.getUserNonce(escrowId, buyerWalletClient.account.address);

    // Sign coordinator message
    const coordSignature = await this.signConfirmDelivery(
      buyerWalletClient,
      escrowId,
      deadline,
      nonce,
    );

    // Sign wallet authorization
    const buyerWalletSig = await this.signWalletAuthorization(
      buyerWalletClient,
      deal.wallet,
      escrowId,
    );

    return { coordSignature, buyerWalletSig, deadline, nonce };
  }

  // ==========================================================================
  // CANCEL FLOWS
  // ==========================================================================

  /**
   * Request cancellation (called by BUYER or SELLER)
   * Contract: requestCancel(escrowId, walletSig)
   * 
   * If both parties request, escrow is automatically canceled.
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

    // Request cancel
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "requestCancel",
      args: [escrowId, walletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Cancel by timeout (called by BUYER after maturity + grace period)
   * Contract: cancelByTimeout(escrowId)
   */
  async cancelByTimeout(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller is buyer
    if (!addressEquals(walletClient.account.address, deal.buyer)) {
      throw new SDKError("Only buyer can cancel by timeout", SDKErrorCode.NOT_BUYER);
    }

    // Cancel by timeout
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "cancelByTimeout",
      args: [escrowId],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // DISPUTE FLOWS
  // ==========================================================================

  /**
   * Start dispute (called by BUYER or SELLER)
   * Contract: startDispute(escrowId)
   */
  async startDispute(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    // Start dispute
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "startDispute",
      args: [escrowId],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Start dispute with signature (gasless)
   * Contract: startDisputeSigned(escrowId, signature, deadline, nonce)
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
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "startDisputeSigned",
      args: [escrowId, signature, deadline, nonce],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Submit dispute evidence (called by BUYER or SELLER)
   * Contract: submitDisputeMessage(escrowId, role, ipfsHash)
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
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "submitDisputeMessage",
      args: [escrowId, role, ipfsHash],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  /**
   * Submit arbiter decision (called by ARBITER)
   * Contract: submitArbiterDecision(escrowId, resolution, ipfsHash, arbiterWalletSig)
   */
  async submitArbiterDecision(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    resolution: DisputeResolution,
    ipfsHash: string,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    // Verify caller is arbiter
    if (!addressEquals(walletClient.account.address, deal.arbiter)) {
      throw new SDKError("Only arbiter can submit decision", SDKErrorCode.NOT_ARBITER);
    }

    // Sign wallet authorization
    const arbiterWalletSig = await this.signWalletAuthorization(
      walletClient,
      deal.wallet,
      escrowId,
    );

    // Submit decision
    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "submitArbiterDecision",
      args: [escrowId, resolution, ipfsHash, arbiterWalletSig],
      account: walletClient.account,
      chain: this.chain,
    });

    await this.waitForReceipt(hash);
    return hash;
  }

  // ==========================================================================
  // WALLET WITHDRAWAL
  // ==========================================================================

  /**
   * Withdraw funds from escrow wallet (called by any participant)
   * Contract: PalindromeEscrowWallet.withdraw()
   * 
   * The wallet contract reads signatures from the escrow contract
   * and verifies 2-of-3 multisig automatically.
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
    const hash = await walletClient.writeContract({
      address: deal.wallet,
      abi: this.abiWallet,
      functionName: "withdraw",
      args: [],
      account: walletClient.account,
      chain: this.chain,
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

  async getEscrowDetail(id: string): Promise<Escrow | undefined> {
    const { data } = await this.apollo.query<{ escrow: Escrow }>({
      query: ESCROW_DETAIL_QUERY,
      variables: { id },
      fetchPolicy: "network-only",
    });
    return data?.escrow;
  }

  async getDisputeMessages(escrowId: string): Promise<any[]> {
    const { data } = await this.apollo.query<{ escrow: { disputeMessages: any[] } }>({
      query: DISPUTE_MESSAGES_BY_ESCROW_QUERY,
      variables: { escrowId },
      fetchPolicy: "network-only",
    });
    return data?.escrow?.disputeMessages ?? [];
  }

  // ==========================================================================
  // UTILITY METHODS
  // ==========================================================================

  /**
   * Get escrow status label
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
    args: any[],
    contractAddress?: Address,
  ): Promise<{
    success: boolean;
    gasEstimate?: bigint;
    revertReason?: string;
    result?: any;
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
    } catch (error: any) {
      // Extract revert reason
      let revertReason = "Unknown error";

      if (error?.cause?.reason) {
        revertReason = error.cause.reason;
      } else if (error?.shortMessage) {
        revertReason = error.shortMessage;
      } else if (error?.message) {
        // Try to parse revert reason from error message
        const match = error.message.match(/reverted with reason string '([^']+)'/);
        if (match) {
          revertReason = match[1];
        } else {
          revertReason = error.message.slice(0, 200);
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
    } catch (error: any) {
      let revertReason = "Unknown error";

      if (error?.shortMessage) {
        revertReason = error.shortMessage;
      } else if (error?.message) {
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
    args: any[],
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
    } catch (e: any) {
      errors.push(`RPC error: ${e?.message}`);
    }

    try {
      await this.getNextEscrowId();
      contractDeployed = true;
    } catch (e: any) {
      errors.push(`Contract error: ${e?.message}`);
    }

    try {
      await this.getEscrows();
      subgraphConnected = true;
    } catch (e: any) {
      errors.push(`Subgraph error: ${e?.message}`);
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
   * Clear all caches
   */
  clearAllCaches(): void {
    this.escrowCache.clear();
    this.tokenDecimalsCache.clear();
  }

  /**
   * Clear escrow cache only
   */
  clearEscrowCache(): void {
    this.escrowCache.clear();
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
          const args = (log as any).args as EscrowCreatedEvent;
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
    const interval = options?.pollingInterval ?? 5000;

    const poll = async () => {
      try {
        const deal = await this.getEscrowByIdParsed(escrowId);
        if (lastState !== null && deal.state !== lastState) {
          callback(deal.state, lastState);
        }
        lastState = deal.state;
      } catch (e) {
        // Silently ignore errors during polling
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

  /**
   * Get fee receiver address
   */
  async getFeeReceiver(): Promise<Address> {
    return this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "feeReceiver",
    }) as Promise<Address>;
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
    } catch {
      // Fall back to default if not readable (private constant)
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

export default PalindromeEscrowSDK;