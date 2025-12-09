// Copyright (c) 2025 Palindrome Finance
// Licensed under the MIT License. See LICENSE file for details.

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
} from "viem";
import { readContract } from "viem/actions";
import PalindromeCryptoEscrowABI from "./contract/PalindromeCryptoEscrow.json";
import PalindromeEscrowWalletABI from "./contract/PalindromeEscrowWallet.json";
import ERC20ABI from "./contract/USDT.json";
import { ApolloClient, InMemoryCache, HttpLink } from "@apollo/client";
import {
  ALL_ESCROWS_QUERY,
  DISPUTE_MESSAGES_BY_ESCROW_QUERY,
  ESCROWS_BY_BUYER_QUERY,
  ESCROWS_BY_SELLER_QUERY,
  ESCROW_DETAIL_QUERY,
} from "./subgraph/queries";
import { Escrow } from "./types/escrow";
import { Chain, hardhat } from "viem/chains";
import { PalindromeEscrowWalletClient } from "./PalindromeEscrowWalletClient";

// ============================================================================
// CONSTANTS
// ============================================================================
const MAX_NONCE_BUCKETS = 16n; // supports first 4096 nonces


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
  EVIDENCE_ALREADY_SUBMITTED = "EVIDENCE_ALREADY_SUBMITTED",
  INVALID_RESOLUTION = "INVALID_RESOLUTION",
  INVALIDTOKEN = "INVALIDTOKEN",
  NETWORK_ERROR = "NETWORK_ERROR",
  CACHE_ERROR = "CACHE_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  RPC_ERROR = "RPC_ERROR",
}

export type EscrowWalletClient = WalletClient<
  Transport,
  Chain,
  Account
>;

export interface EventWatcher {
  dispose: () => void;
}

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

export class WalletClientRequiredError extends SDKError {
  constructor() {
    super("Wallet client is required", SDKErrorCode.WALLET_NOT_CONNECTED);
  }
}

export class WalletAccountRequiredError extends SDKError {
  constructor() {
    super("Wallet account is required", SDKErrorCode.WALLET_ACCOUNT_MISSING);
  }
}

export class InvalidStateError extends SDKError {
  constructor(current: string, expected: string) {
    super(
      `Invalid escrow state. Current: ${current}, Expected: ${expected}`,
      SDKErrorCode.INVALID_STATE
    );
  }
}

export class SignatureDeadlineExpiredError extends SDKError {
  constructor() {
    super("Signature deadline has expired", SDKErrorCode.SIGNATURE_EXPIRED);
  }
}

export type CachePolicy = "default" | "no-cache" | "aggressive";

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
}

const CACHE_KEYS = {
  allEscrows: "all-escrows",
  escrow: (id: bigint | string) => `escrow:${id.toString()}`,
} as const;

export interface PalindromeEscrowSDKConfig {
  publicClient: PublicClient;
  contractAddress: Address;
  walletClient?: EscrowWalletClient;
  apolloClient?: ApolloClient;
  chain?: Chain;
  /** Cache TTL in milliseconds (default: 5000) */
  cacheTTL?: number;
  /** Enable retry logic for failed RPC calls (default: true) */
  enableRetry?: boolean;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Gas buffer percentage (default: 20) */
  gasBuffer?: number;
  /** Subgraph URL override */
  subgraphUrl?: string;
  /** Default ERC20 token used for checks (e.g. USDT) */
  defaultToken?: Address;
  cachePolicy?: CachePolicy;
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

export interface DisputeSubmissionStatus {
  buyer: boolean;
  seller: boolean;
  arbiter: boolean;
  allSubmitted: boolean;
}

export interface MaturityInfo {
  maturityDays: number;
  deadline: Date | null;
  hasDeadline: boolean;
  isPassed: boolean;
  timeRemaining: string;
}

export interface EscrowStatusLabel {
  label: string;
  color: string;
  description: string;
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

export interface SimulationResult {
  success: boolean;
  gasEstimate?: bigint;
  error?: string;
  revertReason?: string;
}

export interface GasPriceStrategy {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

interface RetryConfig {
  maxAttempts: number;
  delayMs: number;
  backoffMultiplier: number;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function assertWalletClient(
  client: EscrowWalletClient | undefined
): asserts client is EscrowWalletClient {
  if (!client) throw new WalletClientRequiredError();
  if (!client.account) throw new WalletAccountRequiredError();
}

async function withRetry<T>(
  operation: () => Promise<T>,
  config: RetryConfig
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;

      if (attempt < config.maxAttempts - 1) {
        const delay = config.delayMs * Math.pow(config.backoffMultiplier, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw new SDKError(
    `Operation failed after ${config.maxAttempts} attempts: ${lastError?.message}`,
    SDKErrorCode.RPC_ERROR,
    { originalError: lastError }
  );
}

function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidAmount(amount: bigint): boolean {
  return amount > 0n;
}

function mapState(
  raw: bigint | number
): { stateValue: EscrowState; stateName: string } {
  const v = Number(raw);
  switch (v) {
    case EscrowState.AWAITING_PAYMENT:
      return { stateValue: v, stateName: "AWAITING_PAYMENT" };
    case EscrowState.AWAITING_DELIVERY:
      return { stateValue: v, stateName: "AWAITING_DELIVERY" };
    case EscrowState.DISPUTED:
      return { stateValue: v, stateName: "DISPUTED" };
    case EscrowState.COMPLETE:
      return { stateValue: v, stateName: "COMPLETE" };
    case EscrowState.REFUNDED:
      return { stateValue: v, stateName: "REFUNDED" };
    case EscrowState.CANCELED:
      return { stateValue: v, stateName: "CANCELED" };
    default:
      return { stateValue: NaN as any, stateName: "UNKNOWN" };
  }
}

// ============================================================================
// MAIN SDK CLASS
// ============================================================================

export class PalindromeEscrowSDK {
  contractAddress: Address;
  abiEscrow: Abi;
  abiEscrowWallet: Abi;
  abiERC20: Abi;
  publicClient: PublicClient;
  walletClient?: EscrowWalletClient;
  apollo: ApolloClient;
  chain: Chain;

  private readonly STATE_NAMES = [
    "AWAITING_PAYMENT",
    "AWAITING_DELIVERY",
    "DISPUTED",
    "COMPLETE",
    "REFUNDED",
    "CANCELED",
  ] as const;

  private readonly cacheTTL: number;
  private readonly enableRetry: boolean;
  private readonly retryConfig: RetryConfig;
  private readonly gasBuffer: number;
  private readonly defaultToken?: Address;
  private readonly cachePolicy: CachePolicy;
  private escrowCache: Map<string, CacheEntry<any>> = new Map();
  private tokenDecimalsCache: Map<Address, number> = new Map();

  constructor(config: PalindromeEscrowSDKConfig) {
    if (!config.contractAddress) {
      throw new SDKError(
        "contractAddress is required in PalindromeEscrowSDKConfig",
        SDKErrorCode.VALIDATION_ERROR
      );
    }
    this.contractAddress = config.contractAddress as Address;
    this.abiEscrow = PalindromeCryptoEscrowABI.abi as Abi;
    this.abiEscrowWallet = PalindromeEscrowWalletABI.abi as Abi;
    this.abiERC20 = ERC20ABI.abi as Abi;
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient as EscrowWalletClient;
    this.chain = config.chain ?? hardhat;
    this.cacheTTL = config.cacheTTL ?? 5000;
    this.enableRetry = config.enableRetry ?? true;
    this.defaultToken = config.defaultToken;
    this.gasBuffer = config.gasBuffer ?? 20;
    this.cachePolicy = config.cachePolicy ?? "default";
    this.retryConfig = {
      maxAttempts: config.maxRetries ?? 3,
      delayMs: 1000,
      backoffMultiplier: 2,
    };

    this.apollo =
      config.apolloClient ??
      new ApolloClient({
        link: new HttpLink({
          uri:
            config.subgraphUrl ??
            "https://api.studio.thegraph.com/query/121986/palindrome-finance-subgraph/version/latest",
        }),
        cache: new InMemoryCache(),
      });

    if (this.walletClient) {
      assertWalletClient(this.walletClient);
      const walletChainId = (this.walletClient as any).chain?.id;
      if (walletChainId != null && walletChainId !== this.chain.id) {
        throw new SDKError(
          `Wallet chainId ${walletChainId} does not match SDK chainId ${this.chain.id}`,
          SDKErrorCode.VALIDATION_ERROR
        );
      }
      const account: any = this.getConnectedAccountOrThrow(this.walletClient);
      const addr =
        typeof account === "string"
          ? account
          : typeof account === "object"
            ? account.address
            : undefined;
      if (!addr || !addr.startsWith("0x")) {
        throw new SDKError(
          "Unsupported walletClient.account shape. Expected 0x-prefixed address.",
          SDKErrorCode.WALLET_ACCOUNT_MISSING
        );
      }
    }
  }

  // ==========================================================================
  // VALIDATION
  // ==========================================================================

  private validateAddress(address: string, name: string): void {
    if (!isValidAddress(address)) {
      throw new SDKError(
        `Invalid ${name} address: ${address}`,
        SDKErrorCode.VALIDATION_ERROR
      );
    }
  }

  private validateAmount(amount: bigint, name: string): void {
    if (!isValidAmount(amount)) {
      throw new SDKError(
        `${name} must be greater than 0`,
        SDKErrorCode.VALIDATION_ERROR
      );
    }
  }

  private async validateEscrowExists(escrowId: bigint): Promise<void> {
    const nextId = await this.getNextEscrowId();
    if (escrowId >= nextId) {
      throw new SDKError(
        `Escrow #${escrowId} does not exist. Next ID: ${nextId}`,
        SDKErrorCode.INVALID_STATE
      );
    }
  }

  // ==========================================================================
  // CACHE
  // ==========================================================================

  private getCached<T>(key: string): T | null {
    const entry = this.escrowCache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > entry.ttl) {
      this.escrowCache.delete(key);
      return null;
    }
    return entry.data as T;
  }

  private setCache<T>(key: string, data: T, ttl?: number): void {
    if (this.cachePolicy === "no-cache") return;
    this.escrowCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.cacheTTL,
    });
  }

  private clearCache(escrowId?: bigint, pattern?: string): void {
    if (escrowId !== undefined) {
      const key = CACHE_KEYS.escrow(escrowId);
      this.escrowCache.delete(key);
      return;
    }

    if (pattern) {
      for (const key of this.escrowCache.keys()) {
        if (key.includes(pattern)) {
          this.escrowCache.delete(key);
        }
      }
      return;
    }

    this.escrowCache.clear();
  }


  public clearAllCaches(): void {
    this.escrowCache.clear();
    this.tokenDecimalsCache.clear();
  }

  public getCacheStats(): {
    escrowCacheSize: number;
    tokenDecimalsCacheSize: number;
  } {
    return {
      escrowCacheSize: this.escrowCache.size,
      tokenDecimalsCacheSize: this.tokenDecimalsCache.size,
    };
  }

  // ==========================================================================
  // RPC / RETRY
  // ==========================================================================

  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.enableRetry) {
      return operation();
    }
    return withRetry(operation, this.retryConfig);
  }

  // ==========================================================================
  // CANCELLATION METHODS
  // ==========================================================================

  /**
   * Cancel escrow after maturity + grace period has passed.
   * Sender must be buyer or seller (enforced by contract).
   */
  async cancelByTimeout(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    // Contract function: cancelByTimeout(uint256 escrowId)
    return this.sendAndConfirm(walletClient, "cancelByTimeout", [escrowId]);
  }

  // ==========================================================================
  // USER BALANCE HELPERS
  // ==========================================================================

  /**
   * Get raw & formatted balances for a user over multiple ERC20 tokens.
   */
  async getUserBalances(
    account: Address,
    tokens: Address[],
  ): Promise<Map<Address, { balance: bigint; formatted: string }>> {
    const balancesMap = new Map<Address, { balance: bigint; formatted: string }>();

    const promises = tokens.map(async (token) => {
      try {
        const [balance, decimals] = await Promise.all([
          this.getTokenBalanceOf(account, token),
          this.getTokenDecimals(token),
        ]);

        const formatted = this.formatTokenAmount(balance, decimals);
        return { token, balance, formatted };
      } catch {
        return { token, balance: 0n, formatted: "0.00" };
      }
    });

    const results = await Promise.all(promises);
    for (const { token, balance, formatted } of results) {
      balancesMap.set(token, { balance, formatted });
    }

    return balancesMap;
  }

  // ==========================================================================
  // ESCROW DATA
  // ==========================================================================

  private async getEscrowDataCached(
    escrowId: bigint,
    forceRefresh = false
  ): Promise<any> {
    const key = CACHE_KEYS.escrow(escrowId);
    if (!forceRefresh && this.cachePolicy !== "no-cache") {
      const cached = this.getCached<any>(key);
      if (cached) return cached;
    }
    const data = await this.executeWithRetry(() => this.getEscrowById(escrowId));
    this.setCache(key, data);
    return data;
  }


  private parseEscrowData(escrow: any): EscrowData {
    return {
      token: escrow.token as Address,
      buyer: escrow.buyer as Address,
      seller: escrow.seller as Address,
      arbiter: escrow.arbiter as Address,
      wallet: escrow.wallet as Address,
      amount: escrow.amount as bigint,
      depositTime: escrow.depositTime as bigint,
      maturityTime: escrow.maturityTime as bigint,
      disputeStartTime: escrow.disputeStartTime as bigint,
      state: Number(escrow.state) as EscrowState,
      buyerCancelRequested: escrow.buyerCancelRequested as boolean,
      sellerCancelRequested: escrow.sellerCancelRequested as boolean,
      tokenDecimals: Number(escrow.tokenDecimals),
    };
  }

  async getEscrowById(escrowId: bigint) {
    return readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getEscrow",
      args: [escrowId],
    });
  }

  async getEscrowByIdParsed(escrowId: bigint): Promise<EscrowData> {
    const raw = await this.getEscrowDataCached(escrowId);
    return this.parseEscrowData(raw);
  }

  /**
 * Get escrows where address is buyer or seller.
 */
  async getEscrowsByParticipant(
    address: string,
  ): Promise<{ asBuyer: Escrow[]; asSeller: Escrow[]; total: Escrow[] }> {
    const [asBuyer, asSeller] = await Promise.all([
      this.getEscrowsByBuyer(address),
      this.getEscrowsBySeller(address),
    ]);

    const totalMap = new Map<string, Escrow>();
    for (const e of asBuyer) totalMap.set(e.id, e);
    for (const e of asSeller) totalMap.set(e.id, e);

    return {
      asBuyer,
      asSeller,
      total: Array.from(totalMap.values()),
    };
  }

  async getEscrowComplete(escrowId: string): Promise<{
    onChain: EscrowData;
    subgraph?: Escrow;
  }> {
    const [onChain, subgraph] = await Promise.all([
      this.getEscrowByIdParsed(BigInt(escrowId)),
      this.getEscrowDetail(escrowId).catch(() => undefined),
    ]);
    return { onChain, subgraph };
  }

  async getNextEscrowId(): Promise<bigint> {
    return readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "nextEscrowId",
      args: [],
    }) as Promise<bigint>;
  }

  async getEscrowWallet(escrowId: bigint): Promise<Address> {
    const deal = await this.getEscrowByIdParsed(escrowId);
    return deal.wallet;
  }

  async getEscrowWalletAndNonce(escrowId: bigint) {
    const deal = await this.getEscrowByIdParsed(escrowId);
    const wallet = deal.wallet;
    const nonce = (await this.publicClient.readContract({
      address: wallet,
      abi: this.abiEscrowWallet,
      functionName: "nonce",
    })) as bigint;
    return { wallet, nonce };
  }


  async getEscrowDataQuick(escrowId: bigint): Promise<EscrowData> {
    return this.getEscrowByIdParsed(escrowId);
  }


  /**
 * Read a per-signer nonce from the bitmap by scanning buckets.
 */
  async getUserNonce(escrowId: bigint, signer: Address): Promise<bigint> {
    for (let bucket = 0n; bucket < MAX_NONCE_BUCKETS; bucket++) {
      const bitmap = (await this.publicClient.readContract({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: "getNonceBitmap",
        args: [escrowId, signer, bucket],
      })) as bigint;

      if (bitmap === 0n) {
        return bucket * 256n;
      }

      for (let bit = 0n; bit < 256n; bit++) {
        const mask = 1n << bit;
        if ((bitmap & mask) === 0n) {
          return bucket * 256n + bit;
        }
      }
    }

    throw new SDKError(
      `No free nonce found in first ${MAX_NONCE_BUCKETS * 256n} slots. Consider creating a new escrow.`,
      SDKErrorCode.INVALID_STATE
    );
  }



  // ==========================================================================
  // SUBGRAPH
  // ==========================================================================

  async getEscrows(useCache = true): Promise<Escrow[]> {
    const key = CACHE_KEYS.allEscrows;

    const shouldUseCache =
      useCache && this.cachePolicy !== "no-cache";

    if (shouldUseCache) {
      const cached = this.getCached<Escrow[]>(key);
      if (cached) return cached;
    }

    const fetchPolicy =
      this.cachePolicy === "aggressive" && useCache
        ? "cache-first"
        : "network-only";

    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ALL_ESCROWS_QUERY,
      fetchPolicy,
    });

    const escrows = data?.escrows ?? [];
    this.setCache(key, escrows, 10000);
    return escrows;
  }


  async getEscrowsByBuyer(buyer: string): Promise<Escrow[]> {
    this.validateAddress(buyer, "buyer");
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_BUYER_QUERY,
      variables: { buyer: buyer.toLowerCase() },
      fetchPolicy: "network-only",
    });
    return data?.escrows ?? [];
  }

  async getEscrowsBySeller(seller: string): Promise<Escrow[]> {
    this.validateAddress(seller, "seller");
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
    const { data } = await this.apollo.query<{
      escrow: { disputeMessages: any[] };
    }>({
      query: DISPUTE_MESSAGES_BY_ESCROW_QUERY,
      variables: { escrowId },
      fetchPolicy: "network-only",
    });
    return data?.escrow?.disputeMessages ?? [];
  }

  // ==========================================================================
  // TOKEN UTILITIES
  // ==========================================================================
  async getTokenDecimals(tokenAddress: Address): Promise<number> {
    if (this.tokenDecimalsCache.has(tokenAddress)) {
      return this.tokenDecimalsCache.get(tokenAddress)!;
    }

    const data = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "decimals",
    });

    const result = await this.executeWithRetry(() =>
      this.publicClient.call({ to: tokenAddress, data })
    );

    if (!result?.data || result.data === "0x") {
      throw new SDKError(
        "Decimals call failed: token may be non-standard or returned no data",
        SDKErrorCode.INVALIDTOKEN,
        { tokenAddress }
      );
    }

    const [decimals] = decodeAbiParameters([{ type: "uint8" }], result.data as Hex);
    const n = Number(decimals);

    if (!Number.isFinite(n) || n < 0 || n > 36) {
      throw new SDKError(
        `Token decimals out of expected range: ${n}`,
        SDKErrorCode.INVALIDTOKEN,
        { tokenAddress }
      );
    }

    this.tokenDecimalsCache.set(tokenAddress, n);
    return n;
  }

  async getTokenBalanceOf(
    account: Address,
    tokenAddress: Address
  ): Promise<bigint> {
    const data = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "balanceOf",
      args: [account],
    });

    const result = await this.executeWithRetry(() =>
      this.publicClient.call({ to: tokenAddress, data })
    );

    if (!result?.data || result.data === "0x") {
      throw new SDKError(
        "Balance call failed: token may be non-standard or returned no data",
        SDKErrorCode.TRANSACTION_FAILED,
        { tokenAddress }
      );
    }

    const [balance] = decodeAbiParameters([{ type: "uint256" }], result.data as Hex);
    return BigInt(balance);
  }


  formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const integerPart = amount / divisor;
    const fractionalStr = (amount % divisor).toString().padStart(decimals, "0");
    return `${integerPart.toString()}.${fractionalStr}`;
  }

  async getTokenAllowance(
    owner: Address,
    spender: Address,
    tokenAddress: Address
  ): Promise<bigint> {
    const data = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "allowance",
      args: [owner, spender],
    });

    const result = await this.executeWithRetry(() =>
      this.publicClient.call({ to: tokenAddress, data })
    );

    if (!result?.data || result.data === "0x") {
      throw new SDKError(
        "Allowance call failed: token may be non-standard or returned no data",
        SDKErrorCode.ALLOWANCE_FAILED,
        { tokenAddress }
      );
    }

    const [allowance] = decodeAbiParameters([{ type: "uint256" }], result.data as Hex);
    return BigInt(allowance);
  }

  private async ensureAllowance(
    walletClient: EscrowWalletClient,
    token: Address,
    owner: Address,
    spender: Address,
    required: bigint
  ): Promise<void> {
    assertWalletClient(walletClient);

    const current = await this.getTokenAllowance(owner, spender, token);
    if (current >= required) return;

    const data = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "approve",
      args: [spender, required],
    });

    const gas = await this.publicClient.estimateGas({
      to: token,
      account: owner,
      data,
    });

    const hash = await walletClient.sendTransaction({
      to: token,
      data,
      gas,
      chain: this.chain,
      account: walletClient.account,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== "success") {
      throw new SDKError(
        "Approve transaction failed on-chain",
        SDKErrorCode.ALLOWANCE_FAILED,
        { txHash: hash, receipt }
      );
    }
  }

  // ==========================================================================
  // MATURITY / DEADLINES
  // ==========================================================================

  calculateDeadline(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): Date | null {
    if (!depositTime) return null;
    const deposit = Number(depositTime);
    const days = Number(maturityTimeDays);
    if (deposit === 0 || days === 0) return null;
    const deadlineTimestamp = deposit + days * 24 * 60 * 60;
    return new Date(deadlineTimestamp * 1000);
  }

  getTimeRemaining(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): string {
    const deadline = this.calculateDeadline(depositTime, maturityTimeDays);
    if (!deadline) return "No deadline";

    const now = new Date();
    const diff = deadline.getTime() - now.getTime();
    if (diff <= 0) return "Deadline passed";

    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    const hours = Math.floor(
      (diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
    );
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h remaining`;
    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
  }

  getMaturityInfo(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): MaturityInfo {
    const maturityDays = Number(maturityTimeDays);
    const deadline = this.calculateDeadline(depositTime, maturityTimeDays);
    const hasDeadline = deadline !== null && maturityDays > 0;
    const isPassed = hasDeadline
      ? new Date() > (deadline as Date)
      : false;
    const timeRemaining = this.getTimeRemaining(depositTime, maturityTimeDays);

    return {
      maturityDays,
      deadline,
      hasDeadline,
      isPassed,
      timeRemaining,
    };
  }

  // ==========================================================================
  // SIGNATURE HELPERS (EIP-712)
  // ==========================================================================

  private getEip712Domain() {
    return {
      name: "PalindromeCryptoEscrow",
      version: "1",
      chainId: this.chain.id,
      verifyingContract: this.contractAddress,
    } as const;
  }

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
      { name: "contractNonce", type: "uint256" },
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
      { name: "contractNonce", type: "uint256" },
    ],
  } as const;

  private readonly requestCancelTypes = {
    RequestCancel: [
      { name: "escrowId", type: "uint256" },
      { name: "buyer", type: "address" },
      { name: "seller", type: "address" },
      { name: "arbiter", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "depositTime", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "contractNonce", type: "uint256" },
    ],
  } as const;

  async createSignatureDeadline(
    minutesFromNow: number = 10
  ): Promise<bigint> {
    const block = await this.publicClient.getBlock();
    const now = Number(block.timestamp);
    return BigInt(now + minutesFromNow * 60);
  }

  isSignatureDeadlineExpired(deadline: bigint, safetySeconds = 5): boolean {
    const now = Math.floor(Date.now() / 1000) + safetySeconds;
    return BigInt(now) > deadline;
  }

  private async buildConfirmDeliveryMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

    // Read contractNonce from the escrow contract
    const contractNonce = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "contractNonce",
    }) as bigint;

    return {
      escrowId,
      buyer: deal.buyer,
      seller: deal.seller,
      arbiter: deal.arbiter,
      token: deal.token,
      amount: deal.amount,
      depositTime: deal.depositTime,
      deadline,
      nonce,
      contractNonce,
    } as const;
  }


  private async buildStartDisputeMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

    const contractNonce = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "contractNonce",
    }) as bigint;

    return {
      escrowId,
      buyer: deal.buyer,
      seller: deal.seller,
      arbiter: deal.arbiter,
      token: deal.token,
      amount: deal.amount,
      depositTime: deal.depositTime,
      deadline,
      nonce,
      contractNonce,
    } as const;
  }


  private async buildRequestCancelMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

    const contractNonce = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "contractNonce",
    }) as bigint;

    return {
      escrowId,
      buyer: deal.buyer,
      seller: deal.seller,
      arbiter: deal.arbiter,
      token: deal.token,
      amount: deal.amount,
      depositTime: deal.depositTime,
      deadline,
      nonce,
      contractNonce,
    } as const;
  }

  async signConfirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);
    const domain = this.getEip712Domain();
    const message = await this.buildConfirmDeliveryMessage(
      escrowId,
      deadline,
      nonce
    );
    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain,
      types: this.confirmDeliveryTypes,
      primaryType: "ConfirmDelivery",
      message,
    });
    return signature as Hex;
  }

  async signStartDispute(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);
    const domain = this.getEip712Domain();
    const message = await this.buildStartDisputeMessage(
      escrowId,
      deadline,
      nonce
    );
    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain,
      types: this.startDisputeTypes,
      primaryType: "StartDispute",
      message,
    });
    return signature as Hex;
  }

  async signRequestCancel(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);
    const domain = this.getEip712Domain();
    const message = await this.buildRequestCancelMessage(
      escrowId,
      deadline,
      nonce
    );
    const signature = await walletClient.signTypedData({
      account: walletClient.account,
      domain,
      types: this.requestCancelTypes,
      primaryType: "RequestCancel",
      message,
    });
    return signature as Hex;
  }

  // ==========================================================================
  // STATUS
  // ==========================================================================

  async getEscrowStatus(escrowId: bigint, forceRefresh?: boolean): Promise<{
    stateValue: number;
    stateName: string;
    escrow: any;
  }> {
    const escrow = await this.getEscrowDataCached(escrowId, forceRefresh);
    const { stateValue, stateName } = mapState(escrow.state);
    return { stateValue, stateName, escrow };
  }

  getEscrowStatusLabel(state: EscrowState): EscrowStatusLabel {
    const labels: Record<EscrowState, EscrowStatusLabel> = {
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
    return (
      labels[state] ?? {
        label: "Unknown",
        color: "gray",
        description: "Unknown escrow state",
      }
    );
  }

  async isInState(
    escrowId: bigint,
    expectedState: EscrowState
  ): Promise<boolean> {
    const { stateValue } = await this.getEscrowStatus(escrowId);
    return stateValue === expectedState;
  }

  // ==========================================================================
  // TRANSACTION EXECUTION
  // ==========================================================================

  private async sendAndConfirm(
    walletClient: EscrowWalletClient,
    functionName: string,
    args: any[]
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const escrowId = args[0] as bigint | undefined;
    if (escrowId !== undefined) this.clearCache(escrowId);

    const account = this.getConnectedAccountOrThrow(walletClient);

    await this.publicClient
      .simulateContract({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName,
        args,
        account,
      })
      .catch((err: any) => {
        const reason = err?.walk?.()?.data?.message || err?.message || "revert";
        throw new SDKError(
          `Transaction would revert: ${reason}`,
          SDKErrorCode.TRANSACTION_FAILED,
          { originalError: err }
        );
      });

    const estimatedGas = await this.publicClient.estimateContractGas({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName,
      args,
      account,
    });

    const gasLimit =
      (estimatedGas * BigInt(100 + this.gasBuffer)) / 100n;

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName,
      args,
      gas: gasLimit,
      account: walletClient.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    if (receipt.status !== "success") {
      throw new SDKError(
        `${functionName} reverted on-chain`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }

    if (escrowId !== undefined) {
      await this.getEscrowDataCached(escrowId, true);
    }
    return txHash;
  }

  async simulateTransaction(
    walletClient: EscrowWalletClient,
    functionName: string,
    args: any[]
  ): Promise<SimulationResult> {
    assertWalletClient(walletClient);

    const account = this.getConnectedAccountOrThrow(walletClient);

    try {
      await this.publicClient.simulateContract({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName,
        args,
        account
      });

      const gasEstimate = await this.publicClient.estimateContractGas({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName,
        args,
        account
      });

      return { success: true, gasEstimate };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Simulation failed",
        revertReason: (error as any)?.walk?.()?.data?.message,
      };
    }
  }

  private getConnectedAccountOrThrow(
    walletClient?: EscrowWalletClient
  ): Address {
    assertWalletClient(walletClient);
    const account: any = walletClient.account;
    const addr =
      typeof account === "string"
        ? account
        : typeof account === "object"
          ? account.address
          : undefined;

    if (!addr || !addr.startsWith("0x")) {
      throw new WalletAccountRequiredError();
    }

    return addr as Address;
  }

  private getUserRoleForEscrow(
    user: Address,
    escrow: EscrowData
  ): Role {
    const u = user.toLowerCase();
    if (u === escrow.buyer.toLowerCase()) return Role.Buyer;
    if (u === escrow.seller.toLowerCase()) return Role.Seller;
    if (u === escrow.arbiter.toLowerCase()) return Role.Arbiter;
    return Role.None;
  }


  // ==========================================================================
  // CORE ESCROW ACTIONS
  // ==========================================================================

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

    // 1) RPC + simple block fetch
    try {
      await this.publicClient.getBlockNumber();
      rpcConnected = true;
    } catch (e: any) {
      errors.push(`RPC error: ${e?.message ?? String(e)}`);
    }

    // 2) Contract deployed – try read nextEscrowId
    try {
      const _ = await this.getNextEscrowId();
      contractDeployed = true;
    } catch (e: any) {
      errors.push(`Contract error: ${e?.message ?? String(e)}`);
    }

    // 3) Subgraph reachable
    try {
      const { data } = await this.apollo.query<{ escrows: { id: string }[] }>({
        query: ALL_ESCROWS_QUERY,
        fetchPolicy: "network-only",
      });
      if (data && Array.isArray(data.escrows)) {
        subgraphConnected = true;
      } else {
        errors.push("Subgraph: unexpected response shape");
      }
    } catch (e: any) {
      errors.push(`Subgraph error: ${e?.message ?? String(e)}`);
    }

    return {
      rpcConnected,
      contractDeployed,
      subgraphConnected,
      errors,
    };
  }

  async createEscrow(
    walletClient: EscrowWalletClient,
    params: CreateEscrowParams
  ) {
    assertWalletClient(walletClient);

    this.validateAddress(params.token, "token");
    this.validateAddress(params.buyer, "buyer");
    this.validateAmount(params.amount, "amount");

    const maturityTimeDays = params.maturityTimeDays ?? 0n;
    const ipfsHash = params.ipfsHash ?? "";
    if (maturityTimeDays > 3650n) {
      throw new SDKError(
        "Maturity time cannot exceed 3650 days (10 years)",
        SDKErrorCode.INVALID_STATE
      );
    }

    const arbiter =
      (params.arbiter ??
        "0x0000000000000000000000000000000000000000") as Address;

    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "createEscrow",
      args: [
        params.token,
        params.buyer,
        params.amount,
        maturityTimeDays,
        arbiter,
        params.title,
        ipfsHash,
      ],
      account: walletClient.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
    });

    if (receipt.status !== "success") {
      throw new SDKError(
        "Transaction failed on-chain",
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }

    try {
      const escrowEvents = parseEventLogs({
        abi: this.abiEscrow,
        eventName: "EscrowCreated",
        logs: receipt.logs,
      }) as Array<{ args: EscrowCreatedEvent }>;

      if (escrowEvents.length > 0) {
        const event = escrowEvents[0].args;
        this.clearCache(undefined, "escrows");
        return {
          escrowId: event.escrowId,
          txHash: hash,
          maturityTime: event.maturityTime,
        };
      }
    } catch (parseError) {
      console.warn("Failed to parse EscrowCreated event:", parseError);
    }

    const nextId = await this.getNextEscrowId();
    const createdId = nextId > 0n ? nextId - 1n : 0n;
    this.clearCache(undefined, "escrows");

    return {
      escrowId: createdId,
      txHash: hash,
      maturityTime: 0n,
    };
  }

  async createEscrowAndDeposit(
    walletClient: EscrowWalletClient,
    params: CreateEscrowAndDepositParams
  ) {
    assertWalletClient(walletClient);
    this.validateAddress(params.token, "token");
    this.validateAddress(params.seller, "seller");
    this.validateAmount(params.amount, "amount");

    const accountAddress = this.getConnectedAccountOrThrow(walletClient);
    if (!accountAddress) {
      throw new SDKError(
        "Missing buyer address.",
        SDKErrorCode.WALLET_ACCOUNT_MISSING
      );
    }
    const spender = this.contractAddress;

    await this.ensureAllowance(
      walletClient,
      params.token,
      accountAddress,
      spender,
      params.amount
    );

    const maturityTimeDays = params.maturityTimeDays ?? 0n;
    const ipfsHash = params.ipfsHash ?? "";
    if (maturityTimeDays > 3650n) {
      throw new SDKError(
        "Maturity time cannot exceed 3650 days (10 years)",
        SDKErrorCode.INVALID_STATE
      );
    }

    const arbiter =
      (params.arbiter ??
        "0x0000000000000000000000000000000000000000") as Address;


    if (!accountAddress) {
      throw new SDKError(
        "Missing buyer address.",
        SDKErrorCode.WALLET_ACCOUNT_MISSING
      );
    }

    const approveData = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "approve",
      args: [this.contractAddress, params.amount] as const,
    });

    const approveTxHash = await walletClient.sendTransaction({
      to: params.token,
      data: approveData,
      account: walletClient.account,
      chain: this.chain,
    });

    const approveReceipt = await this.publicClient.waitForTransactionReceipt(
      {
        hash: approveTxHash,
        confirmations: 1,
      }
    );

    if (approveReceipt.status !== "success") {
      throw new SDKError(
        "Token approval transaction failed",
        SDKErrorCode.ALLOWANCE_FAILED
      );
    }

    const verifyData = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "allowance",
      args: [accountAddress, this.contractAddress] as const,
    });

    const verifyResult = await this.publicClient.call({
      to: params.token,
      data: verifyData,
    });

    const [newAllowance] = decodeAbiParameters(
      [{ type: "uint256" } as const],
      verifyResult.data as Hex
    );

    if (newAllowance < params.amount) {
      throw new SDKError(
        `Allowance verification failed. Expected >= ${params.amount}, Got: ${newAllowance}`,
        SDKErrorCode.ALLOWANCE_FAILED
      );
    }

    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "createEscrowAndDeposit",
      args: [
        params.token,
        params.seller,
        params.amount,
        maturityTimeDays,
        arbiter,
        params.title,
        ipfsHash,
      ],
      account: walletClient.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({
      hash,
    });

    if (receipt.status !== "success") {
      throw new SDKError(
        "Transaction failed on-chain",
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }

    try {
      const escrowEvents = parseEventLogs({
        abi: this.abiEscrow,
        eventName: "EscrowCreated",
        logs: receipt.logs,
      }) as Array<{ args: EscrowCreatedEvent }>;
      if (escrowEvents.length > 0) {
        const event = escrowEvents[0].args;
        this.clearCache(undefined, "escrows");
        return {
          escrowId: event.escrowId,
          txHash: hash,
          maturityTime: event.maturityTime,
        };
      }
    } catch (parseError) {
      console.warn("Failed to parse EscrowCreated event:", parseError);
    }

    const nextId = await this.getNextEscrowId();
    const createdId = nextId > 0n ? nextId - 1n : 0n;
    this.clearCache(undefined, "escrows");
    return {
      escrowId: createdId,
      txHash: hash,
      maturityTime: 0n,
    };
  }

  async deposit(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    assertWalletClient(walletClient);
    await this.validateEscrowExists(escrowId);
    this.clearCache(escrowId);

    const escrow = await this.getEscrowByIdParsed(escrowId);
    const accountAddress = this.getConnectedAccountOrThrow(walletClient);
    if (!accountAddress) {
      throw new SDKError(
        "Missing buyer address.",
        SDKErrorCode.WALLET_ACCOUNT_MISSING
      );
    }
    const spender = this.contractAddress;

    if (accountAddress.toLowerCase() !== escrow.buyer.toLowerCase()) {
      throw new SDKError(
        `Only buyer can deposit. Expected: ${escrow.buyer}, Got: ${accountAddress}`,
        SDKErrorCode.NOT_BUYER
      );
    }

    await this.ensureAllowance(
      walletClient,
      escrow.token,
      accountAddress,
      spender,
      escrow.amount
    );

    if (escrow.state !== EscrowState.AWAITING_PAYMENT) {
      throw new InvalidStateError(
        this.STATE_NAMES[escrow.state] || "UNKNOWN",
        this.STATE_NAMES[EscrowState.AWAITING_PAYMENT]
      );
    }

    const [balance, decimals] = await Promise.all([
      this.getTokenBalanceOf(accountAddress, escrow.token),
      this.getTokenDecimals(escrow.token),
    ]);

    if (balance < escrow.amount) {
      throw new SDKError(
        `Insufficient balance. Required: ${this.formatTokenAmount(
          escrow.amount,
          decimals
        )}, Available: ${this.formatTokenAmount(balance, decimals)}`,
        SDKErrorCode.INSUFFICIENT_BALANCE
      );
    }

    const approveData = encodeFunctionData({
      abi: this.abiERC20,
      functionName: "approve",
      args: [this.contractAddress, escrow.amount] as const,
    });

    const approveTxHash = await walletClient.sendTransaction({
      to: escrow.token,
      data: approveData,
      account: walletClient.account,
      chain: this.chain,
    });

    const approveReceipt = await this.publicClient.waitForTransactionReceipt(
      {
        hash: approveTxHash,
        confirmations: 1,
      }
    );

    if (approveReceipt.status !== "success") {
      throw new SDKError(
        "Token approval transaction failed",
        SDKErrorCode.ALLOWANCE_FAILED
      );
    }

    return this.sendAndConfirm(walletClient, "deposit", [escrowId]);
  }

  async confirmDelivery(
    walletClient: EscrowWalletClient,
    escrowId: bigint
  ): Promise<Hex> {
    return this.sendAndConfirm(walletClient, "confirmDelivery", [escrowId]);
  }

  async confirmDeliverySigned(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    signature: Hex,
    deadline: bigint,
    nonce: bigint,
    ipfsHaesh: string,
  ): Promise<Hex> {
    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const account = this.getConnectedAccountOrThrow(walletClient);
    const escrow = await this.getEscrowByIdParsed(escrowId);

    // State must be AWAITING_DELIVERY
    if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        this.STATE_NAMES[escrow.state],
        "AWAITING_DELIVERY"
      );
    }

    // Only buyer can confirm delivery
    const role = this.getUserRoleForEscrow(account, escrow);
    if (role !== Role.Buyer) {
      throw new SDKError(
        "Only the buyer can confirm delivery",
        SDKErrorCode.NOT_BUYER
      );
    }

    return this.sendAndConfirm(walletClient, "confirmDeliverySigned", [
      escrowId,
      signature,
      deadline,
      nonce,
      ipfsHaesh
    ]);
  }


  async confirmDeliverySignedAsBuyer(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    const buyerAddr = this.getConnectedAccountOrThrow(walletClient) as Address;
    const deal = await this.getEscrowByIdParsed(escrowId);

    if (deal.buyer.toLowerCase() !== buyerAddr.toLowerCase()) {
      throw new Error('Only buyer can confirm delivery');
    }

    // 1) EIP-712 nonce & deadline for ConfirmDelivery (coordinator)
    const userNonce = await this.getUserNonce(escrowId, buyerAddr as Address);
    const deadline = await this.createSignatureDeadline(60);

    const msg = await this.buildConfirmDeliveryMessage(
      escrowId,
      deadline,
      userNonce,
    );

    const confirmDeliverySignature = await walletClient.signTypedData({
      account: walletClient.account!,
      domain: this.getEip712Domain(),
      types: this.confirmDeliveryTypes,
      primaryType: 'ConfirmDelivery',
      message: msg,
    });

    // 2) Build and sign wallet ExecuteSplit as buyer co-signer
    const wallet = deal.wallet as Address;     // escrow wallet address
    const token = deal.token as Address;
    const seller = deal.seller as Address;

    // Fee & net amount must match what the coordinator stored in the wallet
    // If the escrow contract precomputed net/fee and passed them to wallet ctor,
    // you should read them from the wallet instead of recomputing here:
    //
    // const [netAmount, feeAmount, feeTo] = await this.readWalletTerms(wallet);
    //
    // For simplicity, assume 1% fee and same feeReceiver as before:
    const feeTo = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'feeReceiver',
    })) as Address;

    // Wallet nonce is independent from userNonce (coordinator)
    const { nonce: walletNonce } = await this.getEscrowWalletAndNonce(escrowId);

    const walletClientHelper = new PalindromeEscrowWalletClient(
      this.publicClient,
      this.chain.id,
    );

    // Buyer signs wallet ExecuteSplit typed data
    const buyerWalletSig = await walletClientHelper.signExecuteSplit(walletClient, {
      wallet,
      token,
      to: seller,
      feeTo,
      nonce: walletNonce,
    });

    // 3) Call coordinator: EIP-712 ConfirmDelivery + buyerWalletSig as "ipfsHaesh"
    //    The contract treats this string as opaque; off-chain you later parse it
    //    and give it to the seller as coSignerSig.
    const txHash = await this.confirmDeliverySigned(
      walletClient,
      escrowId,
      confirmDeliverySignature as Hex,
      deadline,
      userNonce,
      buyerWalletSig as Hex, // encoded co-signer wallet signature
    );

    return txHash;
  }


  async requestCancel(
    walletClient: EscrowWalletClient,
    escrowId: bigint
  ): Promise<Hex> {
    return this.sendAndConfirm(walletClient, "requestCancel", [escrowId]);
  }

  async requestCancelSigned(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    signature: Hex,
    deadline: bigint,
    nonce: bigint
  ): Promise<Hex> {
    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const account = this.getConnectedAccountOrThrow(walletClient);
    const escrow = await this.getEscrowByIdParsed(escrowId);


    if (
      escrow.state !== EscrowState.AWAITING_PAYMENT &&
      escrow.state !== EscrowState.AWAITING_DELIVERY
    ) {
      throw new InvalidStateError(
        this.STATE_NAMES[escrow.state],
        "AWAITING_PAYMENT or AWAITING_DELIVERY"
      );
    }

    // Only buyer or seller can request cancel
    const role = this.getUserRoleForEscrow(account, escrow);
    if (role === Role.None || role === Role.Arbiter) {
      throw new SDKError(
        "Only buyer or seller can request cancel",
        SDKErrorCode.INVALID_ROLE
      );
    }

    return this.sendAndConfirm(walletClient, "requestCancelSigned", [
      escrowId,
      signature,
      deadline,
      nonce,
    ]);
  }

  async startDisputeSigned(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    signature: Hex,
    deadline: bigint,
    nonce: bigint
  ): Promise<Hex> {
    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const account = this.getConnectedAccountOrThrow(walletClient);
    const escrow = await this.getEscrowByIdParsed(escrowId);

    // Must currently be AWAITING_DELIVERY (or whatever your dispute entry state is)
    if (escrow.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        this.STATE_NAMES[escrow.state],
        "AWAITING_DELIVERY"
      );
    }

    // Only buyer or seller can start a dispute
    const role = this.getUserRoleForEscrow(account, escrow);
    if (role !== Role.Buyer && role !== Role.Seller) {
      throw new SDKError(
        "Only buyer or seller can start a dispute",
        SDKErrorCode.INVALID_ROLE
      );
    }

    return this.sendAndConfirm(walletClient, "startDisputeSigned", [
      escrowId,
      signature,
      deadline,
      nonce,
    ]);
  }

  // ==========================================================================
  // WALLET EXECUTION METHODS
  // ==========================================================================

  /**
   * Execute a split ERC20 payout from the escrow's multisig wallet (2-of-3).
   */
  async executeEscrowERC20Split(
    executor: EscrowWalletClient,
    escrowWalletClient: PalindromeEscrowWalletClient,
    escrowId: bigint,
    to: Address,
    signatures: [Hex, Hex, Hex],
  ): Promise<Hex> {
    // get per-escrow wallet address
    const wallet = await this.getEscrowWallet(escrowId);
    return escrowWalletClient.executeERC20Split(
      executor,
      wallet,
      to,
      signatures,
    );
  }


  async executeEscrowERC20SplitAsSeller(
    sellerWalletClient: EscrowWalletClient,
    escrowId: bigint,
    // EIP-712 co-signer sig (buyer or arbiter) over ExecuteSplit
    coSignerSig: Hex,
  ): Promise<Hex> {
    const deal = await this.getEscrowByIdParsed(escrowId);

    // Enforce seller initiator at SDK level
    const seller = deal.seller as Address;
    if (
      !sellerWalletClient.account ||
      sellerWalletClient.account.address.toLowerCase() !== seller.toLowerCase()
    ) {
      throw new Error('Only seller can execute payout');
    }

    // 1. Get wallet + nonce
    const { wallet, nonce: walletNonce } = await this.getEscrowWalletAndNonce(escrowId);
    const token = deal.token as Address;

    // 2. Compute 1% fee & net amount from deal.amount
    const amount = deal.amount as bigint;
    const feeBps = 100n; // 1%
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    const feeTo = (await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'feeReceiver',
    })) as Address;

    // 3. Build EIP-712 typed data for ExecuteSplit
    const splitWalletClient = new PalindromeEscrowWalletClient(
      this.publicClient,
      this.chain.id,
    );

    // 4. Seller signs the same typed data as co-signer
    const sellerSig = await splitWalletClient.signExecuteSplit(sellerWalletClient, {
      wallet: wallet as Address,
      token,
      to: seller,
      feeTo,
      nonce: walletNonce,
    });

    // 5. Compose signatures array: [co-signer (buyer/arbiter), seller, empty]
    const signatures: [Hex, Hex, Hex] = [coSignerSig, sellerSig, '0x'];

    // 6. Execute split (seller is executor)
    const execTx = await this.executeEscrowERC20Split(
      sellerWalletClient,   // executor (seller)
      splitWalletClient,
      escrowId,
      seller,
      signatures,
    );

    return execTx;
  }

  // ==========================================================================
  // DISPUTE METHODS
  // ==========================================================================

  /**
   * Start a dispute directly on-chain (no signature).
   * Sender must be buyer or seller, state must be AWAITING_DELIVERY.
   */
  async startDispute(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
  ): Promise<Hex> {
    return this.sendAndConfirm(walletClient, "startDispute", [escrowId]);
  }

  /**
 * Submit dispute evidence/message for a given role.
 * Role is enforced in the contract (buyer/seller/arbiter).
 */
  async submitDisputeMessage(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    role: Role,
    ipfsHash: string,
  ): Promise<Hex> {
    // Solidity: submitDisputeMessage(uint256 escrowId, uint8 role, string calldata ipfsHash)
    return this.sendAndConfirm(walletClient, "submitDisputeMessage", [
      escrowId,
      role,
      ipfsHash,
    ]);
  }

  // ==========================================================================
  // DISPUTE STATUS HELPERS
  // ==========================================================================

  /**
   * Returns who has submitted dispute evidence (buyer/seller/arbiter)
   * by decoding the disputeStatus bitmap on-chain.
   */
  async getDisputeSubmissionStatus(escrowId: bigint): Promise<DisputeSubmissionStatus> {
    const status: bigint = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "disputeStatus",
      args: [escrowId],
    }) as bigint;

    const buyer = (status & 1n) !== 0n;
    const seller = (status & 2n) !== 0n;
    const arbiter = (status & 4n) !== 0n;

    return {
      buyer,
      seller,
      arbiter,
      allSubmitted: buyer && seller && arbiter,
    };
  }

  async hasSubmittedEvidence(escrowId: bigint, role: Role): Promise<boolean> {
    const disputeStatus = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "disputeStatus",
      args: [escrowId],
    }) as bigint | number;

    const masks: Record<Role, bigint> = {
      [Role.None]: 0n,
      [Role.Buyer]: 1n << 0n,
      [Role.Seller]: 1n << 1n,
      [Role.Arbiter]: 1n << 2n,
    };

    const ds = typeof disputeStatus === "bigint"
      ? disputeStatus
      : BigInt(disputeStatus);

    return (ds & masks[role]) !== 0n;
  }


  // ==========================================================================
  // ARBITER DECISION
  // ==========================================================================

  /**
   * Submit arbiter decision for a disputed escrow.
   * Arbiter chooses between Complete (3) and Refunded (4).
   */
  async submitArbiterDecision(
    walletClient: EscrowWalletClient,
    escrowId: bigint,
    resolution: DisputeResolution,
    ipfsHash: string,
  ): Promise<Hex> {
    // Solidity: submitArbiterDecision(uint256 escrowId, uint8 resolution, string calldata ipfsHash)
    return this.sendAndConfirm(walletClient, "submitArbiterDecision", [
      escrowId,
      resolution,
      ipfsHash,
    ]);
  }



  // ==========================================================================
  // WALLET CLIENT (2-of-3 multisig)
  // ==========================================================================

  getEscrowWalletClient(walletAddress: Address): PalindromeEscrowWalletClient {
    if (!this.walletClient) {
      throw new WalletClientRequiredError();
    }

    // The walletAddress is *not* stored in the wallet client itself; you pass it
    // when calling executeERC20 / executeERC20Split.
    return new PalindromeEscrowWalletClient(
      this.publicClient,
      this.chain.id, // chainId: number
    );
  }

  /**
  * Poll subgraph for user escrows and invoke callback on change.
  * Simple watcher; replace with Graph subscriptions if needed.
  */
  watchUserEscrows(
    userAddress: Address,
    callback: (escrowId: bigint, event: EscrowCreatedEvent) => void,
    options?: {
      onlyAsBuyer?: boolean;
      onlyAsSeller?: boolean;
      fromBlock?: bigint;
    }
  ): EventWatcher {
    const normalizedAddress = userAddress.toLowerCase();

    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'EscrowCreated',
      ...(options?.fromBlock && { fromBlock: options.fromBlock }),
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) {
            const event = log.args as EscrowCreatedEvent;
            const isBuyer = event.buyer.toLowerCase() === normalizedAddress;
            const isSeller = event.seller.toLowerCase() === normalizedAddress;

            if (options?.onlyAsBuyer && !isBuyer) return;
            if (options?.onlyAsSeller && !isSeller) return;

            if (isBuyer || isSeller) {
              callback(event.escrowId, event);
            }
          }
        });
      }
    });

    return { dispose: unwatch };
  }
}
