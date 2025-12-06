// Copyright (c) 2025 Palindrome Finance
// Licensed under the MIT License. See LICENSE file for details.
import {
  Address, Abi, PublicClient, WalletClient, encodeFunctionData, decodeAbiParameters,
  keccak256, Hex, parseEventLogs, parseAbiParameters, encodeAbiParameters, toBytes
} from "viem";
import { readContract } from "viem/actions";
import PalindromeCryptoEscrowABI from "./contract/PalindromeCryptoEscrow.json";
import USDTABI from "./contract/USDT.json";
import { ApolloClient, InMemoryCache, HttpLink } from '@apollo/client';
import {
  ALL_ESCROWS_QUERY, DISPUTE_MESSAGES_BY_ESCROW_QUERY, ESCROWS_BY_BUYER_QUERY,
  ESCROWS_BY_SELLER_QUERY, ESCROW_DETAIL_QUERY
} from "./subgraph/queries";
import { Escrow } from "./types/escrow";
import { bscTestnet, Chain, hardhat } from "viem/chains";

// ============================================================================
// ENUMS & TYPES
// ============================================================================

export enum EscrowState {
  AWAITING_PAYMENT,
  AWAITING_DELIVERY,
  DISPUTED,
  COMPLETE,
  REFUNDED,
  CANCELED,
  WITHDRAWN
}

export enum DisputeResolution {
  Complete = 3,
  Refunded = 4
}

export enum Role {
  None = 0,
  Buyer = 1,
  Seller = 2,
  Arbiter = 3
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

export enum SDKErrorCode {
  WALLET_NOT_CONNECTED = 'WALLET_NOT_CONNECTED',
  WALLET_ACCOUNT_MISSING = 'WALLET_ACCOUNT_MISSING',
  NOT_BUYER = 'NOT_BUYER',
  NOT_SELLER = 'NOT_SELLER',
  NOT_ARBITER = 'NOT_ARBITER',
  INVALID_STATE = 'INVALID_STATE',
  INSUFFICIENT_BALANCE = 'INSUFFICIENT_BALANCE',
  ALLOWANCE_FAILED = 'ALLOWANCE_FAILED',
  SIGNATURE_EXPIRED = 'SIGNATURE_EXPIRED',
  TRANSACTION_FAILED = 'TRANSACTION_FAILED',
  INVALID_ROLE = 'INVALID_ROLE',
  EVIDENCE_ALREADY_SUBMITTED = 'EVIDENCE_ALREADY_SUBMITTED',
  INVALID_RESOLUTION = 'INVALID_RESOLUTION',
  AWAITING_DELIVERY = "AWAITING_DELIVERY",
  INVALIDTOKEN = "INVALIDTOKEN",
  NETWORK_ERROR = "NETWORK_ERROR",
  CACHE_ERROR = "CACHE_ERROR",
  VALIDATION_ERROR = "VALIDATION_ERROR",
  RPC_ERROR = "RPC_ERROR"
}

export class SDKError extends Error {
  code: SDKErrorCode;
  details?: any;

  constructor(message: string, code: SDKErrorCode, details?: any) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'SDKError';
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
    super(`Invalid escrow state. Current: ${current}, Expected: ${expected}`, SDKErrorCode.INVALID_STATE);
  }
}

export class SignatureDeadlineExpiredError extends SDKError {
  constructor() {
    super("Signature deadline has expired", SDKErrorCode.SIGNATURE_EXPIRED);
  }
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface PalindromeEscrowSDKConfig {
  publicClient: PublicClient;
  contractAddress?: Address;
  buyerWalletClient?: WalletClient;
  sellerWalletClient?: WalletClient;
  walletClient?: WalletClient;
  apollo?: ApolloClient;
  chain?: Chain;
  /** Cache TTL in milliseconds (default: 5000) */
  cacheTTL?: number;
  /** Enable retry logic for failed RPC calls (default: true) */
  enableRetry?: boolean;
  /** Max retry attempts (default: 3) */
  maxRetries?: number;
  /** Gas buffer percentage (default: 20) */
  gasBuffer?: number;
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

export interface FeeCalculation {
  fee: bigint;
  netAmount: bigint;
}

export interface FormattedFeeCalculation {
  amount: string;
  fee: string;
  netAmount: string;
  feePercentage: string;
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
  amount: bigint;
  depositTime: bigint;
  maturityTime: bigint;
  disputeStartTime: bigint;
  state: EscrowState;
  buyerCancelRequested: boolean;
  sellerCancelRequested: boolean;
  buyerWithdrawn: boolean;
  sellerWithdrawn: boolean;
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

export interface PaymentDepositedEvent {
  escrowId: bigint;
  buyer: Address;
  amount: bigint;
  timestamp: bigint;
}

export interface DisputeStartedEvent {
  escrowId: bigint;
  initiator: Address;
  timestamp: bigint;
}

export interface DeliveryConfirmedEvent {
  escrowId: bigint;
  buyer: Address;
  seller: Address;
  amount: bigint;
  fee: bigint;
  timestamp: bigint;
}

export interface DisputeResolvedEvent {
  escrowId: bigint;
  resolution: number;
  arbiter: Address;
  amount: bigint;
  fee: bigint;
  timestamp: bigint;
}

export interface DisputeMessagePostedEvent {
  escrowId: bigint;
  sender: Address;
  role: number;
  ipfsHash: string;
  disputeStatus: bigint;
  timestamp: bigint;
}

export interface RequestCancelEvent {
  escrowId: bigint;
  requester: Address;
  timestamp: bigint;
}

export interface CanceledEvent {
  escrowId: bigint;
  initiator: Address;
  amount: bigint;
  fee: bigint;
  timestamp: bigint;
}

export interface EventWatcher {
  dispose: () => void;
}

/**  Transaction simulation result */
export interface SimulationResult {
  success: boolean;
  gasEstimate?: bigint;
  error?: string;
  revertReason?: string;
}

export interface BatchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface GasPriceStrategy {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
}

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  ttl: number;
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
  client: WalletClient | undefined
): asserts client is WalletClient & { account: NonNullable<WalletClient["account"]> } {
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
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw new SDKError(
    `Operation failed after ${config.maxAttempts} attempts: ${lastError?.message}`,
    SDKErrorCode.RPC_ERROR,
    { originalError: lastError }
  );
}

/**  Validate Ethereum address */
function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**  Validate amount is positive */
function isValidAmount(amount: bigint): boolean {
  return amount > 0n;
}


// ============================================================================
// MAIN SDK CLASS (OPTIMIZED)
// ============================================================================

export class PalindromeEscrowSDK {
  contractAddress: Address;
  abiEscrow: Abi;
  abiUSDT: Abi;
  publicClient: PublicClient;
  buyerWalletClient?: WalletClient;
  sellerWalletClient?: WalletClient;
  walletClient?: WalletClient;
  apollo: ApolloClient;
  chain: Chain;

  private readonly FEE_BPS = 100n;
  private readonly BPS_DENOMINATOR = 10000n;
  private readonly STATE_NAMES = [
    'AWAITING_PAYMENT',
    'AWAITING_DELIVERY',
    'DISPUTED',
    'COMPLETE',
    'REFUNDED',
    'CANCELED',
    'WITHDRAWN'
  ] as const;

  // Configuration
  private readonly cacheTTL: number;
  private readonly enableRetry: boolean;
  private readonly retryConfig: RetryConfig;
  private readonly gasBuffer: number;

  // Cache system (OPTIMIZED)
  private escrowCache: Map<string, CacheEntry<any>> = new Map();
  private tokenDecimalsCache: Map<Address, number> = new Map();
  private allowedTokensCache: Map<Address, { allowed: boolean; timestamp: number }> = new Map();

  // Subgraph
  private SUBGRAPH_URL = "https://api.studio.thegraph.com/query/121986/palindrome-finance-subgraph/version/latest";
  private CONTRACT_ADDRESS = "0x75cbec0819e137e5febf3bdf13d626d33d331487";

  private apolloClient: ApolloClient;

  constructor(config: PalindromeEscrowSDKConfig) {
    this.contractAddress = (config.contractAddress ?? this.CONTRACT_ADDRESS) as Address;
    this.abiEscrow = PalindromeCryptoEscrowABI.abi as Abi;
    this.abiUSDT = USDTABI.abi as Abi;
    this.publicClient = config.publicClient;
    this.sellerWalletClient = config.sellerWalletClient;
    this.buyerWalletClient = config.buyerWalletClient;
    this.walletClient = config.walletClient;
    this.chain = config.chain ?? hardhat;
    this.cacheTTL = config.cacheTTL ?? 5000;
    this.enableRetry = config.enableRetry ?? true;
    this.gasBuffer = config.gasBuffer ?? 20;
    this.retryConfig = {
      maxAttempts: config.maxRetries ?? 3,
      delayMs: 1000,
      backoffMultiplier: 2
    };

    this.apolloClient = new ApolloClient({
      link: new HttpLink({ uri: this.SUBGRAPH_URL }),
      cache: new InMemoryCache(),
    });
    this.apollo = this.apolloClient;
  }

  // ==========================================================================
  // VALIDATION METHODS (NEW)
  // ==========================================================================

  /**
   * Validate address format
   */
  private validateAddress(address: string, name: string): void {
    if (!isValidAddress(address)) {
      throw new SDKError(
        `Invalid ${name} address: ${address}`,
        SDKErrorCode.VALIDATION_ERROR
      );
    }
  }

  /**
   * Validate amount is positive
   */
  private validateAmount(amount: bigint, name: string): void {
    if (!isValidAmount(amount)) {
      throw new SDKError(
        `${name} must be greater than 0`,
        SDKErrorCode.VALIDATION_ERROR
      );
    }
  }

  /**
   *  Validate escrow exists
   */
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
  // CACHE MANAGEMENT (OPTIMIZED)
  // ==========================================================================

  /**
   * OPTIMIZED: Get cached data with TTL support
   */
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

  /**
   * OPTIMIZED: Set cache with custom TTL
   */
  private setCache<T>(key: string, data: T, ttl?: number): void {
    this.escrowCache.set(key, {
      data,
      timestamp: Date.now(),
      ttl: ttl ?? this.cacheTTL
    });
  }

  /**
   * OPTIMIZED: Clear cache for specific escrow or pattern
   */
  private clearCache(escrowId?: bigint, pattern?: string): void {
    if (escrowId !== undefined) {
      const key = `escrow:${escrowId.toString()}`;
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

  /**
   *  Clear all caches (including token decimals)
   */
  public clearAllCaches(): void {
    this.escrowCache.clear();
    this.tokenDecimalsCache.clear();
    this.allowedTokensCache.clear();
  }

  /**
   *  Get cache statistics
   */
  public getCacheStats(): {
    escrowCacheSize: number;
    tokenDecimalsCacheSize: number;
    allowedTokensCacheSize: number;
  } {
    return {
      escrowCacheSize: this.escrowCache.size,
      tokenDecimalsCacheSize: this.tokenDecimalsCache.size,
      allowedTokensCacheSize: this.allowedTokensCache.size
    };
  }

  // ==========================================================================
  // RPC OPTIMIZATION (NEW)
  // ==========================================================================

  /**
   *  Execute RPC call with retry logic
   */
  private async executeWithRetry<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.enableRetry) {
      return operation();
    }

    return withRetry(operation, this.retryConfig);
  }

  /**
   *  Batch read multiple escrows (multicall pattern)
   */
  async getEscrowsBatch(escrowIds: bigint[]): Promise<BatchResult<EscrowData>[]> {
    const results: BatchResult<EscrowData>[] = [];

    // Execute in parallel for better performance
    const promises = escrowIds.map(async (id) => {
      try {
        const data = await this.getEscrowByIdParsed(id);
        return { success: true, data } as BatchResult<EscrowData>;
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error'
        } as BatchResult<EscrowData>;
      }
    });

    return Promise.all(promises);
  }

  /**
   *  Get multiple token decimals in parallel
   */
  async getTokenDecimalsBatch(tokens: Address[]): Promise<Map<Address, number>> {
    const decimalsMap = new Map<Address, number>();

    const promises = tokens.map(async (token) => {
      try {
        const decimals = await this.getTokenDecimals(token);
        return { token, decimals };
      } catch {
        return { token, decimals: 18 }; // fallback
      }
    });

    const results = await Promise.all(promises);
    results.forEach(({ token, decimals }) => {
      decimalsMap.set(token, decimals);
    });

    return decimalsMap;
  }

  // ==========================================================================
  // ESCROW DATA RETRIEVAL (OPTIMIZED)
  // ==========================================================================

  /**
   * OPTIMIZED: Get escrow data with smart caching
   */
  private async getEscrowDataCached(escrowId: bigint, forceRefresh = false): Promise<any> {
    const key = `escrow:${escrowId.toString()}`;

    if (!forceRefresh) {
      const cached = this.getCached<any>(key);
      if (cached) return cached;
    }

    const data = await this.executeWithRetry(() => this.getEscrowById(escrowId));
    this.setCache(key, data);
    return data;
  }

  /**
   * Parse escrow tuple array into structured object
   * NOW INCLUDES: disputeStartTime, buyerWithdrawn, sellerWithdrawn
   */
  private parseEscrowData(escrow: any): EscrowData {
    return {
      token: escrow[0] as Address,
      buyer: escrow[1] as Address,
      seller: escrow[2] as Address,
      arbiter: escrow[3] as Address,
      amount: escrow[4] as bigint,
      depositTime: escrow[5] as bigint,
      maturityTime: escrow[6] as bigint,
      disputeStartTime: escrow[7] as bigint,
      state: Number(escrow[8]) as EscrowState,
      buyerCancelRequested: escrow[9] as boolean,
      sellerCancelRequested: escrow[10] as boolean,
      buyerWithdrawn: escrow[11] as boolean,
      sellerWithdrawn: escrow[12] as boolean,
    };
  }

  /**
   * Get escrow by ID from contract
   */
  async getEscrowById(escrowId: bigint) {
    return readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "escrows",
      args: [escrowId]
    });
  }

  /**
   * Get parsed escrow data by ID
   */
  async getEscrowByIdParsed(escrowId: bigint): Promise<EscrowData> {
    const escrow = await this.getEscrowDataCached(escrowId);
    return this.parseEscrowData(escrow);
  }

  /**
   *  Get escrow with full details (on-chain + subgraph)
   */
  async getEscrowComplete(escrowId: string): Promise<{
    onChain: EscrowData;
    subgraph?: Escrow;
  }> {
    const [onChain, subgraph] = await Promise.all([
      this.getEscrowByIdParsed(BigInt(escrowId)),
      this.getEscrowDetail(escrowId).catch(() => undefined)
    ]);

    return { onChain, subgraph };
  }

  // ==========================================================================
  // SUBGRAPH QUERIES (OPTIMIZED)
  // ==========================================================================

  /**
   * OPTIMIZED: Get all escrows with caching
   */
  async getEscrows(useCache = true): Promise<Escrow[]> {
    const key = 'all-escrows';

    if (useCache) {
      const cached = this.getCached<Escrow[]>(key);
      if (cached) return cached;
    }

    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ALL_ESCROWS_QUERY,
      fetchPolicy: useCache ? 'cache-first' : 'network-only'
    });

    const escrows = data?.escrows ?? [];
    this.setCache(key, escrows, 10000); // 10s TTL for list queries
    return escrows;
  }

  /**
   * Get escrows by buyer address
   */
  async getEscrowsByBuyer(buyer: string): Promise<Escrow[]> {
    this.validateAddress(buyer, 'buyer');

    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_BUYER_QUERY,
      variables: { buyer: buyer.toLowerCase() },
      fetchPolicy: "network-only"
    });
    return data?.escrows ?? [];
  }

  /**
   * Get escrows by seller address
   */
  async getEscrowsBySeller(seller: string): Promise<Escrow[]> {
    this.validateAddress(seller, 'seller');

    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_SELLER_QUERY,
      variables: { seller: seller.toLowerCase() },
      fetchPolicy: "network-only"
    });
    return data?.escrows ?? [];
  }

  /**
   *  Get escrows by participant (buyer OR seller)
   */
  async getEscrowsByParticipant(address: string): Promise<{
    asBuyer: Escrow[];
    asSeller: Escrow[];
    total: Escrow[];
  }> {
    const [asBuyer, asSeller] = await Promise.all([
      this.getEscrowsByBuyer(address),
      this.getEscrowsBySeller(address)
    ]);

    const totalMap = new Map<string, Escrow>();
    [...asBuyer, ...asSeller].forEach(e => totalMap.set(e.id, e));

    return {
      asBuyer,
      asSeller,
      total: Array.from(totalMap.values())
    };
  }

  /**
   * Get detailed escrow information from subgraph
   */
  async getEscrowDetail(id: string): Promise<Escrow | undefined> {
    const { data } = await this.apollo.query<{ escrow: Escrow }>({
      query: ESCROW_DETAIL_QUERY,
      variables: { id },
      fetchPolicy: "network-only"
    });
    return data?.escrow;
  }

  /**
   * Get dispute messages
   */
  async getDisputeMessages(escrowId: string): Promise<any[]> {
    const { data } = await this.apollo.query<{
      escrow: { disputeMessages: any[] };
    }>({
      query: DISPUTE_MESSAGES_BY_ESCROW_QUERY,
      variables: { escrowId },
      fetchPolicy: "network-only"
    });

    return data?.escrow?.disputeMessages ?? [];
  }

  // ==========================================================================
  // TOKEN UTILITIES (OPTIMIZED)
  // ==========================================================================

  /**
   * OPTIMIZED: Get token decimals with caching
   */
  async getTokenDecimals(tokenAddress: Address): Promise<number> {
    // Check cache first
    if (this.tokenDecimalsCache.has(tokenAddress)) {
      return this.tokenDecimalsCache.get(tokenAddress)!;
    }

    const decimalsData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: "decimals"
    });

    const decimalsResult = await this.executeWithRetry(() =>
      this.publicClient.call({
        to: tokenAddress,
        data: decimalsData
      })
    );

    const [decimals] = decodeAbiParameters([{ type: "uint8" }], decimalsResult.data as Hex);
    const decimalsNum = Number(decimals);

    // Cache the result
    this.tokenDecimalsCache.set(tokenAddress, decimalsNum);

    return decimalsNum;
  }

  /**
   * Get USDT balance for an account
   */
  async getUSDTBalanceOf(account: Address, tokenAddress: Address): Promise<bigint> {
    const balanceData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: "balanceOf",
      args: [account],
    });

    const balanceResult = await this.executeWithRetry(() =>
      this.publicClient.call({
        to: tokenAddress,
        data: balanceData
      })
    );

    if (!balanceResult?.data || balanceResult.data === '0x') {
      throw new SDKError(
        'Balance call failed: No valid data returned',
        SDKErrorCode.TRANSACTION_FAILED
      );
    }

    const [balance] = decodeAbiParameters([{ type: "uint256" }], balanceResult.data as Hex);
    return BigInt(balance);
  }

  /**
   * Get USDT balance of escrow contract
   */
  async getEscrowUSDTBalance(tokenAddress: Address): Promise<bigint> {
    return this.getUSDTBalanceOf(this.contractAddress, tokenAddress);
  }

  /**
   * Get formatted USDT balance of escrow contract
   */
  async getEscrowUSDTBalanceFormatted(tokenAddress: Address): Promise<string> {
    const [rawBalance, decimals] = await Promise.all([
      this.getEscrowUSDTBalance(tokenAddress),
      this.getTokenDecimals(tokenAddress)
    ]);
    return this.formatTokenAmount(rawBalance, decimals);
  }

  /**
   * Format token amount with decimals
   */
  formatTokenAmount(amount: bigint, decimals: number): string {
    const divisor = 10n ** BigInt(decimals);
    const integerPart = amount / divisor;
    const fractionalStr = (amount % divisor).toString().padStart(decimals, "0");
    return `${integerPart.toString()}.${fractionalStr}`;
  }

  /**
   * OPTIMIZED: Check if token is allowed with caching
   */
  async isTokenAllowed(tokenAddress: Address): Promise<boolean> {
    const cached = this.allowedTokensCache.get(tokenAddress);
    const now = Date.now();

    if (cached && now - cached.timestamp < 60000) { // 1 min cache
      return cached.allowed;
    }

    const result = await this.executeWithRetry(() =>
      readContract(this.publicClient, {
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: "allowedTokens",
        args: [tokenAddress]
      })
    );

    const allowed = result as boolean;
    this.allowedTokensCache.set(tokenAddress, { allowed, timestamp: now });

    return allowed;
  }

  /**
   *  Get all user balances for multiple tokens
   */
  async getUserBalances(
    account: Address,
    tokens: Address[]
  ): Promise<Map<Address, { balance: bigint; formatted: string }>> {
    const balancesMap = new Map<Address, { balance: bigint; formatted: string }>();

    const promises = tokens.map(async (token) => {
      try {
        const [balance, decimals] = await Promise.all([
          this.getUSDTBalanceOf(account, token),
          this.getTokenDecimals(token)
        ]);
        return {
          token,
          balance,
          formatted: this.formatTokenAmount(balance, decimals)
        };
      } catch {
        return { token, balance: 0n, formatted: '0.00' };
      }
    });

    const results = await Promise.all(promises);
    results.forEach(({ token, balance, formatted }) => {
      balancesMap.set(token, { balance, formatted });
    });

    return balancesMap;
  }

  // ==========================================================================
  // FEE CALCULATION
  // ==========================================================================

  /**
   * Calculate fee and net amount
   */
  calculateFee(amount: bigint, customBps?: bigint): FeeCalculation {
    const bps = customBps ?? this.FEE_BPS;
    const fee = (amount * bps) / this.BPS_DENOMINATOR;
    const netAmount = amount - fee;
    return { fee, netAmount };
  }

  /**
   * Get formatted fee calculation
   */
  formatFeeCalculation(
    amount: bigint,
    decimals: number,
    customBps?: bigint
  ): FormattedFeeCalculation {
    const { fee, netAmount } = this.calculateFee(amount, customBps);
    const bps = customBps ?? this.FEE_BPS;
    const percentage = ((Number(bps) / 10000) * 100).toFixed(2);

    return {
      amount: this.formatTokenAmount(amount, decimals),
      fee: this.formatTokenAmount(fee, decimals),
      netAmount: this.formatTokenAmount(netAmount, decimals),
      feePercentage: `${percentage}%`
    };
  }

  async previewFees(token: Address): Promise<bigint> {
    const claimable = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "previewFees",
      args: [token],
    });
    return claimable as bigint;
  }

  async previewFeesFormatted(token: Address): Promise<string> {
    const [claimable, decimals] = await Promise.all([
      this.previewFees(token),
      this.getTokenDecimals(token),
    ]);
    return this.formatTokenAmount(claimable, decimals);
  }

  // ==========================================================================
  // MATURITY TIME UTILITIES
  // ==========================================================================

  /**
   * Calculate deadline from deposit time and maturity days
   */
  calculateDeadline(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): Date | null {
    if (!depositTime) return null;

    const deposit = Number(depositTime);
    const days = Number(maturityTimeDays);

    if (deposit === 0 || days === 0) return null;

    const deadlineTimestamp = deposit + (days * 24 * 60 * 60);
    return new Date(deadlineTimestamp * 1000);
  }

  /**
   * Check if maturity deadline has passed
   */
  isDeadlinePassed(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): boolean {
    const deadline = this.calculateDeadline(depositTime, maturityTimeDays);
    if (!deadline) return false;
    return new Date() > deadline;
  }

  /**
   * Get time remaining until deadline
   */
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
    const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

    if (days > 0) return `${days}d ${hours}h remaining`;
    if (hours > 0) return `${hours}h ${minutes}m remaining`;
    return `${minutes}m remaining`;
  }

  /**
   * Format maturity days
   */
  formatMaturityDays(maturityTimeDays: bigint | number | string): string {
    const days = Number(maturityTimeDays);

    if (days === 0) return "No auto-release";
    if (days === 1) return "1 day";
    if (days < 30) return `${days} days`;

    const months = Math.floor(days / 30);
    const remainingDays = days % 30;

    if (remainingDays === 0) {
      return `${months} month${months > 1 ? 's' : ''}`;
    }

    return `${months} month${months > 1 ? 's' : ''} ${remainingDays} day${remainingDays > 1 ? 's' : ''}`;
  }

  /**
   * Get complete maturity info
   */
  getMaturityInfo(
    depositTime: bigint | number | string | null,
    maturityTimeDays: bigint | number | string
  ): MaturityInfo {
    const maturityDays = Number(maturityTimeDays);
    const deadline = this.calculateDeadline(depositTime, maturityTimeDays);
    const hasDeadline = deadline !== null && maturityDays > 0;
    const isPassed = hasDeadline ? this.isDeadlinePassed(depositTime, maturityTimeDays) : false;
    const timeRemaining = this.getTimeRemaining(depositTime, maturityTimeDays);

    return {
      maturityDays,
      deadline,
      hasDeadline,
      isPassed,
      timeRemaining
    };
  }

  // ==========================================================================
  // SIGNATURE UTILITIES
  // ==========================================================================

  /**
   * Create signature deadline
   */
  async createSignatureDeadline(minutesFromNow: number = 10): Promise<bigint> {
    const block = await this.publicClient.getBlock();
    const now = Number(block.timestamp); // Chain-Zeit in Sekunden
    return BigInt(now + minutesFromNow * 60);
  }


  /**
   * Check if signature deadline expired
   */
  isSignatureDeadlineExpired(deadline: bigint): boolean {
    const now = Math.floor(Date.now() / 1000);
    return BigInt(now) > deadline;
  }

  // =======================
  // EIP-712 HELPERS
  // =======================

  /**
 * EIP-712 domain for PalindromeCryptoEscrow.
 * Must match Solidity _domainSeparator() name/version/chainId/contract.
 */
  private getEip712Domain() {
    return {
      name: 'PalindromeCryptoEscrow',
      version: '1',
      chainId: this.chain.id,
      verifyingContract: this.contractAddress,
    } as const;
  }

  private async buildConfirmDeliveryMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

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
    } as const;
  }


  private async buildStartDisputeMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

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
    } as const;
  }

  private async buildRequestCancelMessage(
    escrowId: bigint,
    deadline: bigint,
    nonce: bigint,
  ) {
    const deal = await this.getEscrowByIdParsed(escrowId);

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
    } as const;
  }

  /**
   * EIP-712 types for ConfirmDelivery.
   */
  private readonly confirmDeliveryTypes = {
    ConfirmDelivery: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'arbiter', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'depositTime', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  } as const;

  private readonly startDisputeTypes = {
    StartDispute: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'arbiter', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'depositTime', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  } as const;

  private readonly requestCancelTypes = {
    RequestCancel: [
      { name: 'escrowId', type: 'uint256' },
      { name: 'buyer', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'arbiter', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'depositTime', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  } as const;


  // ==========================================================================
  // ESCROW STATE MANAGEMENT
  // ==========================================================================

  /**
   * Get escrow status
   */
  async getEscrowStatus(
    escrowId: bigint,
    forceRefresh?: boolean,
  ): Promise<{
    stateValue: number;
    stateName: string;
    escrow: any;
  }> {
    const escrow = await this.getEscrowDataCached(escrowId, forceRefresh);
    const stateValue = Number(escrow[8]);
    const stateName = this.STATE_NAMES[stateValue] ?? 'UNKNOWN';
    return { stateValue, stateName, escrow };
  }

  /**
   * Get escrow status label
   */
  getEscrowStatusLabel(state: EscrowState): EscrowStatusLabel {
    const labels: Record<EscrowState, EscrowStatusLabel> = {
      [EscrowState.AWAITING_PAYMENT]: {
        label: 'Awaiting Payment',
        color: 'orange',
        description: 'Buyer needs to deposit funds',
      },
      [EscrowState.AWAITING_DELIVERY]: {
        label: 'Awaiting Delivery',
        color: 'blue',
        description: 'Seller should deliver product/service',
      },
      [EscrowState.DISPUTED]: {
        label: 'Disputed',
        color: 'red',
        description: 'Dispute in progress - arbiter will resolve',
      },
      [EscrowState.COMPLETE]: {
        label: 'Complete',
        color: 'green',
        description: 'Transaction completed successfully',
      },
      [EscrowState.REFUNDED]: {
        label: 'Refunded',
        color: 'gray',
        description: 'Funds returned to buyer',
      },
      [EscrowState.CANCELED]: {
        label: 'Canceled',
        color: 'gray',
        description: 'Escrow was canceled',
      },
      [EscrowState.WITHDRAWN]: {
        label: 'Withdrawn',
        color: 'gray',
        description: 'Withdrawn',
      },
    };

    return (
      labels[state] ?? {
        label: 'Unknown',
        color: 'gray',
        description: 'Unknown escrow state',
      }
    );
  }

  /**
   * Check if escrow is in expected state
   */
  async isInState(escrowId: bigint, expectedState: EscrowState): Promise<boolean> {
    const { stateValue } = await this.getEscrowStatus(escrowId);
    return stateValue === expectedState;
  }

  /**
   *  Get withdrawable amounts for both parties
   */
  async getWithdrawableAmounts(escrowId: bigint): Promise<{
    buyer: bigint;
    seller: bigint;
  }> {
    const [buyer, seller, escrow] = await Promise.all([
      readContract(this.publicClient, {
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: "getWithdrawable",
        args: [escrowId, (await this.getEscrowByIdParsed(escrowId)).buyer]
      }) as Promise<bigint>,
      readContract(this.publicClient, {
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName: "getWithdrawable",
        args: [escrowId, (await this.getEscrowByIdParsed(escrowId)).seller]
      }) as Promise<bigint>,
      this.getEscrowByIdParsed(escrowId)
    ]);

    return { buyer, seller };
  }

  // ==========================================================================
  // TRANSACTION EXECUTION (OPTIMIZED)
  // ==========================================================================

  /**
   * Send transaction with gas estimation and retry
   */
  private async sendAndConfirm(
    walletClient: WalletClient,
    functionName: string,
    args: any[]
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const account = walletClient.account.address;

    await this.publicClient.simulateContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName,
      args,
      account,
    }).catch((err: any) => {
      const reason = err?.walk?.()?.data?.message || err?.message || 'unknown revert';
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

    const gasLimit = (estimatedGas * BigInt(100 + this.gasBuffer)) / 100n;

    const txHash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName,
      args,
      gas: gasLimit,
      account: walletClient.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      throw new SDKError(
        `${functionName} reverted on-chain`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }

    return txHash;
  }

  /**
   *  Simulate transaction without sending
   */
  async simulateTransaction(
    walletClient: WalletClient,
    functionName: string,
    args: any[]
  ): Promise<SimulationResult> {
    assertWalletClient(walletClient);

    try {
      const { result } = await this.publicClient.simulateContract({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName,
        args,
        account: walletClient.account.address,
      });

      const gasEstimate = await this.publicClient.estimateContractGas({
        address: this.contractAddress,
        abi: this.abiEscrow,
        functionName,
        args,
        account: walletClient.account.address,
      });

      return {
        success: true,
        gasEstimate
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Simulation failed',
        revertReason: (error as any)?.walk?.()?.data?.message
      };
    }
  }

  /**
   * Safely extract account address from wallet client
   */
  private getAccountAddress(walletClient: WalletClient): Address | null {
    const account = walletClient.account;

    if (!account) {
      return null;
    }

    if (typeof account === 'string') {
      const addr = account as string;
      return addr.startsWith('0x') ? (addr as Address) : null;
    }

    if (typeof account === 'object') {
      const accountObj = account as any;

      if (accountObj.address && typeof accountObj.address === 'string') {
        const addr = accountObj.address as string;
        return addr.startsWith('0x') ? (addr as Address) : null;
      }
    }

    return null;
  }

  // ==========================================================================
  // CORE ESCROW ACTIONS
  // ==========================================================================

  /**
   * Create new escrow
   */
  async createEscrow(walletClient: WalletClient, params: CreateEscrowParams) {
    assertWalletClient(walletClient);

    // Validate inputs
    this.validateAddress(params.token, 'token');
    this.validateAddress(params.buyer, 'buyer');
    this.validateAmount(params.amount, 'amount');

    // Check token is allowed
    const isAllowed = await this.isTokenAllowed(params.token);
    if (!isAllowed) {
      throw new SDKError(`Token ${params.token} not allowed`, SDKErrorCode.INVALIDTOKEN);
    }

    const maturityTimeDays = params.maturityTimeDays ?? 0n;
    const ipfsHash = params.ipfsHash ?? "";

    if (maturityTimeDays > 3650n) {
      throw new SDKError(
        "Maturity time cannot exceed 3650 days (10 years)",
        SDKErrorCode.INVALID_STATE
      );
    }

    const arbiter = (params.arbiter ?? '0x0000000000000000000000000000000000000000') as Address;

    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'createEscrow',
      args: [
        params.token,
        params.buyer,
        params.amount,
        maturityTimeDays,
        arbiter,
        params.title,
        ipfsHash
      ],
      account: walletClient.account,
      chain: this.chain
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      throw new SDKError(
        "Transaction failed on-chain",
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }

    // Try to parse event
    try {
      const escrowEvents = parseEventLogs({
        abi: this.abiEscrow,
        eventName: 'EscrowCreated',
        logs: receipt.logs
      }) as Array<{ args: EscrowCreatedEvent }>;

      if (escrowEvents.length > 0) {
        const event = escrowEvents[0].args;

        // Invalidate cache
        this.clearCache(undefined, 'escrows');

        return {
          escrowId: event.escrowId,
          txHash: hash,
          maturityTime: event.maturityTime
        };
      }
    } catch (parseError) {
      console.warn('Failed to parse EscrowCreated event:', parseError);
    }

    try {
      const nextId = await this.getNextEscrowId();
      const createdId = nextId > 0n ? nextId - 1n : 0n;

      console.warn(`EscrowCreated event not found. Assuming escrow ID: ${createdId}`);

      this.clearCache(undefined, 'escrows');

      return {
        escrowId: createdId,
        txHash: hash,
        maturityTime: 0n
      };
    } catch (fallbackError) {
      throw new SDKError(
        `Escrow may have been created, but event not found. Transaction: ${hash}. Please check the transaction manually.`,
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }
  }


  async createEscrowAndDeposit(walletClient: WalletClient, params: CreateEscrowAndDepositParams) {
    assertWalletClient(walletClient);

    // Validate inputs
    this.validateAddress(params.token, 'token');
    this.validateAddress(params.seller, 'seller');
    this.validateAmount(params.amount, 'amount');

    // Check token is allowed
    const isAllowed = await this.isTokenAllowed(params.token);
    if (!isAllowed) {
      throw new SDKError(`Token ${params.token} not allowed`, SDKErrorCode.INVALIDTOKEN);
    }

    const maturityTimeDays = params.maturityTimeDays ?? 0n;
    const ipfsHash = params.ipfsHash ?? "";

    if (maturityTimeDays > 3650n) {
      throw new SDKError(
        "Maturity time cannot exceed 3650 days (10 years)",
        SDKErrorCode.INVALID_STATE
      );
    }

    const arbiter = (params.arbiter ?? '0x0000000000000000000000000000000000000000') as Address;

    const approveData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: 'approve',
      args: [this.contractAddress, params.amount] as const,
    });

    const approveTxHash = await walletClient.sendTransaction({
      to: params.token,
      data: approveData,
      account: walletClient.account,
      chain: this.chain,
    });

    const approveReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
      confirmations: 1
    });

    if (approveReceipt.status !== 'success') {
      throw new SDKError('Token approval transaction failed', SDKErrorCode.ALLOWANCE_FAILED);
    }

    const accountAddress = this.getAccountAddress(walletClient);
    if (!accountAddress) {
      throw new SDKError('Missing buyer address.', SDKErrorCode.WALLET_ACCOUNT_MISSING);
    }

    const verifyData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: 'allowance',
      args: [accountAddress, this.contractAddress] as const,
    });

    const verifyResult = await this.publicClient.call({
      to: params.token,
      data: verifyData
    });

    const [newAllowance] = decodeAbiParameters(
      [{ type: 'uint256' } as const],
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
      functionName: 'createEscrowAndDeposit',
      args: [
        params.token,
        params.seller,
        params.amount,
        maturityTimeDays,
        arbiter,
        params.title,
        ipfsHash
      ],
      account: walletClient.account,
      chain: this.chain
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status !== 'success') {
      throw new SDKError(
        "Transaction failed on-chain",
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }

    // Try to parse event
    try {
      const escrowEvents = parseEventLogs({
        abi: this.abiEscrow,
        eventName: 'EscrowCreated',
        logs: receipt.logs
      }) as Array<{ args: EscrowCreatedEvent }>;

      if (escrowEvents.length > 0) {
        const event = escrowEvents[0].args;

        // Invalidate cache
        this.clearCache(undefined, 'escrows');

        return {
          escrowId: event.escrowId,
          txHash: hash,
          maturityTime: event.maturityTime
        };
      }
    } catch (parseError) {
      console.warn('Failed to parse EscrowCreated event:', parseError);
    }

    try {
      const nextId = await this.getNextEscrowId();
      const createdId = nextId > 0n ? nextId - 1n : 0n;

      console.warn(`EscrowCreated event not found. Assuming escrow ID: ${createdId}`);

      this.clearCache(undefined, 'escrows');

      return {
        escrowId: createdId,
        txHash: hash,
        maturityTime: 0n
      };
    } catch (fallbackError) {
      throw new SDKError(
        `Escrow may have been created, but event not found. Transaction: ${hash}. Please check the transaction manually.`,
        SDKErrorCode.TRANSACTION_FAILED,
        { txHash: hash, receipt }
      );
    }
  }

  /**
   * Deposit with comprehensive validation
   */
  async deposit(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    assertWalletClient(walletClient);

    const accountAddress = this.getAccountAddress(walletClient);
    if (!accountAddress) {
      throw new SDKError('Missing buyer address.', SDKErrorCode.WALLET_ACCOUNT_MISSING);
    }

    // Fresh data
    this.clearCache(escrowId);
    const escrow = await this.getEscrowDataCached(escrowId, true);
    const parsed = this.parseEscrowData(escrow);

    // Role validation
    if (accountAddress.toLowerCase() !== parsed.buyer.toLowerCase()) {
      throw new SDKError(
        `Only buyer can deposit. Expected: ${parsed.buyer}, Got: ${accountAddress}`,
        SDKErrorCode.NOT_BUYER
      );
    }

    // State validation
    if (parsed.state !== EscrowState.AWAITING_PAYMENT) {
      throw new InvalidStateError(
        this.STATE_NAMES[parsed.state] || 'UNKNOWN',
        this.STATE_NAMES[EscrowState.AWAITING_PAYMENT]
      );
    }

    if (!parsed.token || parsed.token === '0x0000000000000000000000000000000000000000') {
      throw new SDKError('Invalid token address in escrow', SDKErrorCode.INVALID_ROLE);
    }

    const isAllowed = await this.isTokenAllowed(parsed.token);
    if (!isAllowed) {
      throw new SDKError(`Token not whitelisted: ${parsed.token}`, SDKErrorCode.INVALIDTOKEN);
    }

    const [balance, decimals] = await Promise.all([
      this.getUSDTBalanceOf(accountAddress, parsed.token),
      this.getTokenDecimals(parsed.token)
    ]);

    if (balance < parsed.amount) {
      throw new SDKError(
        `Insufficient balance. Required: ${this.formatTokenAmount(parsed.amount, decimals)}, Available: ${this.formatTokenAmount(balance, decimals)}`,
        SDKErrorCode.INSUFFICIENT_BALANCE
      );
    }

    console.log(`📤 Approving ${this.formatTokenAmount(parsed.amount, decimals)} for escrow #${escrowId.toString()}`);

    const approveData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: 'approve',
      args: [this.contractAddress, parsed.amount] as const,
    });

    const approveTxHash = await walletClient.sendTransaction({
      to: parsed.token,
      data: approveData,
      account: walletClient.account,
      chain: this.chain,
    });

    const approveReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: approveTxHash,
      confirmations: 1
    });

    if (approveReceipt.status !== 'success') {
      throw new SDKError('Token approval transaction failed', SDKErrorCode.ALLOWANCE_FAILED);
    }


    const verifyData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: 'allowance',
      args: [accountAddress, this.contractAddress] as const,
    });

    const verifyResult = await this.publicClient.call({
      to: parsed.token,
      data: verifyData
    });

    const [newAllowance] = decodeAbiParameters(
      [{ type: 'uint256' } as const],
      verifyResult.data as Hex
    );

    if (newAllowance < parsed.amount) {
      throw new SDKError(
        `Allowance verification failed. Expected >= ${parsed.amount}, Got: ${newAllowance}`,
        SDKErrorCode.ALLOWANCE_FAILED
      );
    }

    const txHash = await this.sendAndConfirm(walletClient, 'deposit', [escrowId]);
    this.clearCache(escrowId);

    return txHash;
  }

  /**
   * Confirm delivery
   */
  async confirmDelivery(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "confirmDelivery", [escrowId]);
  }

  /**
   * Confirm delivery with EIP-712 typed signature.
   */
  async confirmDeliverySigned(
    walletClient: WalletClient,
    escrowId: bigint,
    opts?: { expiryMinutes?: number },
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    const caller = walletClient.account!.address.toLowerCase();
    if (caller !== deal.buyer.toLowerCase()) {
      throw new SDKError('Only buyer can confirm delivery', SDKErrorCode.NOT_BUYER);
    }
    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        EscrowState[deal.state],
        EscrowState[EscrowState.AWAITING_DELIVERY],
      );
    }

    // 1) Read nonce from contract
    const nonce = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'getBuyerNonce',
      args: [escrowId],
    }) as bigint;

    // 2) Compute deadline (EIP-712 payload field)
    const expiryMinutes = opts?.expiryMinutes ?? 60;
    const deadline = await this.createSignatureDeadline(expiryMinutes);

    // 3) Build typed message
    const message = await this.buildConfirmDeliveryMessage(escrowId, deadline, nonce);

    // 4) EIP-712 signTypedData
    const signature = await walletClient.signTypedData({
      account: walletClient.account!,
      domain: this.getEip712Domain(),
      types: this.confirmDeliveryTypes,
      primaryType: 'ConfirmDelivery',
      message,
    });

    // 5) Call meta-tx function
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, 'confirmDeliverySigned', [
      escrowId,
      signature,
      deadline,
      nonce,
    ]);
  }

  /**
   * Withdraw funds for ecrowId
   */
  async withdraw(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    assertWalletClient(walletClient);

    const escrow = await this.getEscrowDataCached(escrowId, true);
    const parsed = this.parseEscrowData(escrow);

    if (
      ![EscrowState.CANCELED, EscrowState.COMPLETE, EscrowState.REFUNDED].includes(parsed.state)
    ) {
      throw new SDKError(
        `Withdrawals only allowed after escrow ends. State: ${EscrowState[parsed.state]}`,
        SDKErrorCode.INVALID_STATE
      );
    }

    try {
      const txHash = await this.sendAndConfirm(walletClient, "withdraw", [escrowId]);
      this.clearCache(escrowId);
      return txHash;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new SDKError(
        `Withdraw transaction failed: ${errorMessage}`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }
  }

  /**
   * Withdraw full aggregated balance for a specific ERC20 token.
   * Wraps contract withdrawAll(address token).
   */
  async withdrawAllToken(
    walletClient: WalletClient,
    token: Address
  ): Promise<Hex> {
    assertWalletClient(walletClient);
    this.validateAddress(token, 'token');

    try {
      const txHash = await this.sendAndConfirm(
        walletClient,
        'withdrawAll',
        [token]
      );
      this.clearCache(undefined, `aggregated:${token.toLowerCase()}`);
      return txHash;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new SDKError(
        `withdrawAll transaction failed: ${errorMessage}`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }
  }



  // ==========================================================================
  // CANCELLATION METHODS
  // ==========================================================================

  /**
   * Request cancellation
   */
  async requestCancel(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "requestCancel", [escrowId]);
  }

  /**
   * Request cancellation with signature
   */
  async requestCancelSigned(
    walletClient: WalletClient,
    escrowId: bigint,
    opts?: { expiryMinutes?: number },
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        EscrowState[deal.state],
        EscrowState[EscrowState.AWAITING_DELIVERY],
      );
    }

    const signerAddr = walletClient.account!.address as Address;
    const lower = signerAddr.toLowerCase();
    const isBuyer = lower === deal.buyer.toLowerCase();
    const isSeller = lower === deal.seller.toLowerCase();

    if (!isBuyer && !isSeller) {
      throw new SDKError('Caller must be buyer or seller', SDKErrorCode.INVALID_ROLE);
    }

    const nonce = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: isBuyer ? 'getBuyerNonce' : 'getSellerNonce',
      args: [escrowId],
    }) as bigint;

    const expiryMinutes = opts?.expiryMinutes ?? 60;
    const deadline = await this.createSignatureDeadline(expiryMinutes);

    const message = await this.buildRequestCancelMessage(escrowId, deadline, nonce);

    const signature = await walletClient.signTypedData({
      account: walletClient.account!,
      domain: this.getEip712Domain(),
      types: this.requestCancelTypes,
      primaryType: 'RequestCancel',
      message,
    });

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, 'requestCancelSigned', [
      escrowId,
      signature,
      deadline,
      nonce,
    ]);
  }

  /**
   * Cancel by timeout
   */
  async cancelByTimeout(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "cancelByTimeout", [escrowId]);
  }

  // ==========================================================================
  // DISPUTE METHODS
  // ==========================================================================

  /**
   * Start dispute
   */
  async startDispute(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "startDispute", [escrowId]);
  }

  /**
   * Submit dispute message
   */
  async submitDisputeMessage(
    walletClient: WalletClient,
    escrowId: bigint,
    role: Role,
    ipfsHash: string
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (![Role.Buyer, Role.Seller, Role.Arbiter].includes(role)) {
      throw new SDKError(
        "Invalid role. Must be Buyer (1), Seller (2), or Arbiter (3)",
        SDKErrorCode.INVALID_ROLE
      );
    }

    if (!ipfsHash?.trim()) {
      throw new SDKError("IPFS hash is required", SDKErrorCode.INVALID_STATE);
    }

    const { stateValue } = await this.getEscrowStatus(escrowId);
    if (stateValue !== EscrowState.DISPUTED) {
      throw new InvalidStateError(
        EscrowState[stateValue],
        EscrowState[EscrowState.DISPUTED]
      );
    }

    const hasSubmitted = await this.hasSubmittedEvidence(escrowId, role);
    if (hasSubmitted) {
      const roleName = ['', 'Buyer', 'Seller', 'Arbiter'][role];
      throw new SDKError(
        `${roleName} has already submitted evidence`,
        SDKErrorCode.EVIDENCE_ALREADY_SUBMITTED
      );
    }

    return this.sendAndConfirm(walletClient, "submitDisputeMessage", [
      escrowId,
      role,
      ipfsHash
    ]);
  }

  /**
   * Check if evidence submitted
   */
  async hasSubmittedEvidence(escrowId: bigint, role: Role): Promise<boolean> {
    const disputeStatus = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'disputeStatus',
      args: [escrowId]
    }) as number;

    const masks: Record<Role, bigint> = {
      [Role.None]: 0n,
      [Role.Buyer]: 1n << 0n,
      [Role.Seller]: 1n << 1n,
      [Role.Arbiter]: 1n << 2n,
    };

    const ds = BigInt(disputeStatus);
    return (ds & masks[role]) !== 0n;
  }

  /**
   * Get dispute submission status
   */
  async getDisputeSubmissionStatus(escrowId: bigint): Promise<DisputeSubmissionStatus> {
    const disputeStatus = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'disputeStatus',
      args: [escrowId]
    }) as number;

    const ds = BigInt(disputeStatus);
    const buyer = (ds & (1n << 0n)) !== 0n;
    const seller = (ds & (1n << 1n)) !== 0n;
    const arbiter = (ds & (1n << 2n)) !== 0n;

    return {
      buyer,
      seller,
      arbiter,
      allSubmitted: buyer && seller && arbiter
    };
  }

  /**
   * Submit arbiter decision
   */
  async submitArbiterDecision(
    walletClient: WalletClient,
    escrowId: bigint,
    resolution: DisputeResolution,
    ipfsHash: string,
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (
      resolution !== DisputeResolution.Complete &&
      resolution !== DisputeResolution.Refunded
    ) {
      throw new SDKError(
        'Resolution must be COMPLETE or REFUNDED',
        SDKErrorCode.INVALID_STATE,
      );
    }

    if (!ipfsHash || !ipfsHash.trim()) {
      throw new SDKError('IPFS hash is required', SDKErrorCode.INVALID_STATE);
    }

    const escrow = await this.getEscrowDataCached(escrowId, true);
    const parsed = this.parseEscrowData(escrow);

    const caller = walletClient.account.address.toLowerCase();
    if (caller !== parsed.arbiter.toLowerCase()) {
      throw new SDKError('Only arbiter can submit decision', SDKErrorCode.INVALID_ROLE);
    }
    if (parsed.state !== EscrowState.DISPUTED) {
      throw new InvalidStateError(
        EscrowState[parsed.state],
        EscrowState[EscrowState.DISPUTED],
      );
    }

    this.clearCache(escrowId);

    return this.sendAndConfirm(walletClient, 'submitArbiterDecision', [
      escrowId,
      resolution,
      ipfsHash,
    ]);
  }

  // ==========================================================================
  // ADMIN METHODS
  // ==========================================================================
  /**
   * Get owner
   */
  async getOwner(): Promise<Address> {
    const owner = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "owner"
    });
    return owner as Address;
  }

  /**
   * Get next escrow ID
   */
  async getNextEscrowId(): Promise<bigint> {
    const nextId = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "nextEscrowId"
    });
    return nextId as bigint;
  }

  /**
   * Withdraw fees (owner only)
   */
  async withdrawFees(walletClient: WalletClient, token: Address): Promise<Hex> {
    return this.sendAndConfirm(walletClient, "withdrawFees", [token]);
  }

  /**
   * Start dispute using signed message (meta-transaction)
   * @param walletClient - Wallet client of the executor (typically arbiter)
   * @param escrowId - The escrow ID
   * @returns Transaction hash
   */
  async startDisputeSigned(
    walletClient: WalletClient,
    escrowId: bigint,
    opts?: { expiryMinutes?: number },
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const deal = await this.getEscrowByIdParsed(escrowId);

    if (deal.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        EscrowState[deal.state],
        EscrowState[EscrowState.AWAITING_DELIVERY],
      );
    }

    const signerAddr = walletClient.account!.address as Address;
    const lower = signerAddr.toLowerCase();
    const isBuyer = lower === deal.buyer.toLowerCase();
    const isSeller = lower === deal.seller.toLowerCase();

    if (!isBuyer && !isSeller) {
      throw new SDKError('Signer must be buyer or seller', SDKErrorCode.INVALID_ROLE);
    }

    // Role-specific nonce (matches _getRoleNonce usage in Solidity)
    const nonce = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: isBuyer ? 'getBuyerNonce' : 'getSellerNonce',
      args: [escrowId],
    }) as bigint;

    const expiryMinutes = opts?.expiryMinutes ?? 60;
    const deadline = await this.createSignatureDeadline(expiryMinutes);

    const message = await this.buildStartDisputeMessage(escrowId, deadline, nonce);

    const signature = await walletClient.signTypedData({
      account: walletClient.account!,
      domain: this.getEip712Domain(),
      types: this.startDisputeTypes,
      primaryType: 'StartDispute',
      message,
    });

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, 'startDisputeSigned', [
      escrowId,
      signature,
      deadline,
      nonce,
    ]);
  }

  /**
   * Get the fee pool balance for a specific token
   * @param token - Token address
   * @returns Fee pool balance
   */
  async getFeePool(token: Address): Promise<bigint> {
    return await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getFeePool",
      args: [token]
    }) as bigint;
  }

  /**
   * Get buyer's nonce for an escrow
   * @param escrowId - The escrow ID
   * @returns Buyer's current nonce
   */
  async getBuyerNonce(escrowId: bigint): Promise<bigint> {
    return await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getBuyerNonce",
      args: [escrowId]
    }) as bigint;
  }

  /**
   * Get seller's nonce for an escrow
   * @param escrowId - The escrow ID
   * @returns Seller's current nonce
   */
  async getSellerNonce(escrowId: bigint): Promise<bigint> {
    return await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getSellerNonce",
      args: [escrowId]
    }) as bigint;
  }

  /**
   * Get arbiter's nonce for an escrow
   * @param escrowId - The escrow ID
   * @returns Arbiter's current nonce
   */
  async getArbiterNonce(escrowId: bigint): Promise<bigint> {
    return await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "getArbiterNonce",
      args: [escrowId]
    }) as bigint;
  }

  /**
   * Helper to create signature hash for signed methods
   * @private
   */
  private async createSignatureHash(
    escrowId: bigint,
    deal: EscrowData,
    functionName: string,
    deadline: bigint,
    nonce: bigint
  ): Promise<`0x${string}`> {
    // This matches the contract's structHash
    const structHash = keccak256(
      encodeAbiParameters(
        [
          { type: 'uint256' },  // chainId
          { type: 'address' },  // contract
          { type: 'bytes4' },   // function selector
          { type: 'uint256' },  // escrowId
          { type: 'address' },  // buyer
          { type: 'address' },  // seller
          { type: 'address' },  // arbiter
          { type: 'address' },  // token
          { type: 'uint256' },  // amount
          { type: 'uint256' },  // depositTime
          { type: 'uint256' },  // deadline
          { type: 'uint256' },  // nonce
        ],
        [
          BigInt(this.chain.id),
          this.contractAddress,
          keccak256(toBytes(`${functionName}(uint256,bytes,uint256,uint256)`)).slice(0, 10) as `0x${string}`,
          escrowId,
          deal.buyer as `0x${string}`,
          deal.seller as `0x${string}`,
          deal.arbiter as `0x${string}`,
          deal.token as `0x${string}`,
          deal.amount,
          deal.depositTime,
          deadline,
          nonce,
        ]
      )
    );

    return structHash;
  }

  // ==========================================================================
  // EVENT WATCHERS
  // ==========================================================================

  /**
   * Watch EscrowCreated events
   */
  watchEscrowCreated(
    callback: (event: EscrowCreatedEvent) => void,
    fromBlock?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'EscrowCreated',
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      },
      ...(fromBlock && { fromBlock })
    });

    return { dispose: unwatch };
  }

  /**
   * Watch PaymentDeposited events
   */
  watchPaymentDeposited(
    callback: (event: PaymentDepositedEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'PaymentDeposited',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch DisputeStarted events
   */
  watchDisputeStarted(
    callback: (event: DisputeStartedEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'DisputeStarted',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch DeliveryConfirmed events
   */
  watchDeliveryConfirmed(
    callback: (event: DeliveryConfirmedEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'DeliveryConfirmed',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch DisputeResolved events
   */
  watchDisputeResolved(
    callback: (event: DisputeResolvedEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'DisputeResolved',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch DisputeMessagePosted events
   */
  watchDisputeMessagePosted(
    callback: (event: DisputeMessagePostedEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'DisputeMessagePosted',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch RequestCancel events
   */
  watchRequestCancel(
    callback: (event: RequestCancelEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'RequestCancel',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch Canceled events
   */
  watchCanceled(
    callback: (event: CanceledEvent) => void,
    escrowId?: bigint
  ): EventWatcher {
    const unwatch = this.publicClient.watchContractEvent({
      address: this.contractAddress,
      abi: this.abiEscrow,
      eventName: 'Canceled',
      args: escrowId ? { escrowId } : undefined,
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) callback(log.args);
        });
      }
    });

    return { dispose: unwatch };
  }

  /**
   * Watch all events
   */
  watchAllEvents(callback: (event: any) => void): EventWatcher {
    const watchers = [
      this.watchEscrowCreated(callback),
      this.watchPaymentDeposited(callback),
      this.watchDisputeStarted(callback),
      this.watchDeliveryConfirmed(callback),
      this.watchDisputeResolved(callback),
      this.watchDisputeMessagePosted(callback),
      this.watchRequestCancel(callback),
      this.watchCanceled(callback),
    ];

    return {
      dispose: () => watchers.forEach(w => w.dispose())
    };
  }

  /**
   * Watch user escrows
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

  // ==========================================================================
  // HEALTH & DIAGNOSTICS (NEW)
  // ==========================================================================

  /**
   *  Check SDK health and connectivity
   */
  async healthCheck(): Promise<{
    rpcConnected: boolean;
    subgraphConnected: boolean;
    contractDeployed: boolean;
    blockNumber?: bigint;
    chainId?: number;
    errors: string[];
  }> {
    const errors: string[] = [];
    let rpcConnected = false;
    let subgraphConnected = false;
    let contractDeployed = false;
    let blockNumber: bigint | undefined;
    let chainId: number | undefined;

    // Test RPC connection
    try {
      blockNumber = await this.publicClient.getBlockNumber();
      chainId = await this.publicClient.getChainId();
      rpcConnected = true;
    } catch (error) {
      errors.push(`RPC connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      await this.getEscrows(false);
      subgraphConnected = true;
    } catch (error) {
      errors.push(`Subgraph connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    try {
      await this.getNextEscrowId();
      contractDeployed = true;
    } catch (error) {
      errors.push(`Contract not deployed or not accessible: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return {
      rpcConnected,
      subgraphConnected,
      contractDeployed,
      blockNumber,
      chainId,
      errors
    };
  }

  /**
   *  Get escrow quick data (fast, no subgraph)
   */
  async getEscrowDataQuick(escrowId: bigint): Promise<{
    id: string;
    buyer: Address;
    seller: Address;
    arbiter: Address;
    amount: bigint;
    token: Address;
    state: EscrowState;
    stateName: string;
    maturityTime: bigint;
    depositTime: bigint;
    buyerCancelRequested: boolean;
    sellerCancelRequested: boolean;
  }> {
    const escrow = await this.getEscrowById(escrowId);
    const parsed = this.parseEscrowData(escrow);

    return {
      id: escrowId.toString(),
      buyer: parsed.buyer,
      seller: parsed.seller,
      arbiter: parsed.arbiter,
      amount: parsed.amount,
      token: parsed.token,
      state: parsed.state,
      stateName: this.STATE_NAMES[parsed.state] ?? 'UNKNOWN',
      maturityTime: parsed.maturityTime,
      depositTime: parsed.depositTime,
      buyerCancelRequested: parsed.buyerCancelRequested,
      sellerCancelRequested: parsed.sellerCancelRequested,
    };
  }
}