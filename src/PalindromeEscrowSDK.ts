import {
  Address, Abi, PublicClient, WalletClient, encodeFunctionData, decodeAbiParameters,
  keccak256, encodePacked, Hex, parseEventLogs
} from "viem";
import { readContract } from "viem/actions";
import PalindromeCryptoEscrowABI from "./contract/PalindromeCryptoEscrow.json";
import USDTABI from "./contract/USDT.json";
import type { ApolloClient } from "@apollo/client";
import {
  ALL_ESCROWS_QUERY, DISPUTE_MESSAGES_BY_ESCROW_QUERY, ESCROWS_BY_BUYER_QUERY, ESCROWS_BY_SELLER_QUERY, ESCROW_DETAIL_QUERY
} from "./subgraph/queries";
import { Escrow } from "./types/escrow";
import { bscTestnet, Chain } from "viem/chains";

/**
 * =================================================================
 * ESCROW STRUCT INDEX REFERENCE (from smart contract)
 * =================================================================
 * 
 * struct EscrowDeal {
 *   address token;                   // Index 0
 *   address buyer;                   // Index 1
 *   address seller;                  // Index 2
 *   address arbiter;                 // Index 3
 *   uint256 amount;                  // Index 4
 *   uint256 depositTime;             // Index 5
 *   uint256 maturityTime;            // Index 6
 *   State state;                     // Index 7
 *   bool buyerCancelRequested;       // Index 8
 *   bool sellerCancelRequested;      // Index 9
 * }
 * 
 * Usage:
 * const escrow = await sdk.getEscrowById(escrowId) as any;
 * const token = escrow[0] as Address;
 * const buyer = escrow[1] as Address;
 * =================================================================
 */

// ============================================================================
// ENUMS & TYPES
// ============================================================================

/** Contract state enum */
export enum EscrowState {
  AWAITING_PAYMENT,
  AWAITING_DELIVERY,
  DISPUTED,
  COMPLETE,
  REFUNDED,
  CANCELED
}

/** Dispute resolution enum */
export enum DisputeResolution {
  Complete = 3,
  Refunded = 4
}

/** Role enum for participants */
export enum Role {
  None = 0,
  Buyer = 1,
  Seller = 2,
  Arbiter = 3
}

// ============================================================================
// ERROR CODES & CLASSES
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
}

export class SDKError extends Error {
  code: SDKErrorCode;

  constructor(message: string, code: SDKErrorCode) {
    super(message);
    this.code = code;
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
// UTILITY FUNCTIONS
// ============================================================================

/** Assert wallet client is properly configured */
function assertWalletClient(
  client: WalletClient | undefined
): asserts client is WalletClient & { account: NonNullable<WalletClient["account"]> } {
  if (!client) throw new WalletClientRequiredError();
  if (!client.account) throw new WalletAccountRequiredError();
}

// ============================================================================
// INTERFACES
// ============================================================================

export interface PalindromeEscrowSDKConfig {
  contractAddress: Address;
  publicClient: PublicClient;
  buyerWalletClient?: WalletClient;
  sellerWalletClient?: WalletClient;
  walletClient?: WalletClient;
  apollo: ApolloClient;
  chain?: Chain;
}

export interface CreateEscrowParams {
  token: Address;
  buyer: Address;
  amount: bigint;
  maturityTimeDays?: bigint;
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
  state: EscrowState;
  buyerCancelRequested: boolean;
  sellerCancelRequested: boolean;
}

type EscrowCreatedArgs = {
  escrowId: bigint;
  buyer: string;
  seller: string;
  token: string;
  amount: bigint;
  arbiter: string;
  maturityTime: bigint;
  title: string;
  ipfsHash: string;
};

export interface EventWatcher {
  dispose: () => void;
}

// ============================================================================
// MAIN SDK CLASS
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

  // Fee constants (matches contract)
  private readonly FEE_BPS = 100n; // 1% = 100 basis points
  private readonly BPS_DENOMINATOR = 10000n;

  // Cache for escrow data to reduce RPC calls
  private escrowCache: Map<string, { data: any; timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5000; // 5 seconds

  constructor(config: PalindromeEscrowSDKConfig) {
    this.contractAddress = config.contractAddress;
    this.abiEscrow = PalindromeCryptoEscrowABI.abi as Abi;
    this.abiUSDT = USDTABI.abi as Abi;
    this.publicClient = config.publicClient;
    this.sellerWalletClient = config.sellerWalletClient;
    this.buyerWalletClient = config.buyerWalletClient;
    this.walletClient = config.walletClient;
    this.apollo = config.apollo;
    this.chain = config.chain ?? bscTestnet;
  }

  // ==========================================================================
  // PRIVATE UTILITY METHODS
  // ==========================================================================

  /**
   * Get escrow data with caching
   * @private
   */
  private async getEscrowDataCached(escrowId: bigint, forceRefresh = false): Promise<any> {
    const key = escrowId.toString();
    const now = Date.now();

    if (!forceRefresh && this.escrowCache.has(key)) {
      const cached = this.escrowCache.get(key)!;
      if (now - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }
    }

    const data = await this.getEscrowById(escrowId);
    this.escrowCache.set(key, { data, timestamp: now });
    return data;
  }

  /**
   * Clear cache for specific escrow or all
   * @private
   */
  private clearCache(escrowId?: bigint) {
    if (escrowId) {
      this.escrowCache.delete(escrowId.toString());
    } else {
      this.escrowCache.clear();
    }
  }

  /**
   * Parse escrow tuple into structured object
   * @private
   */


  /**
   * Parse escrow tuple array into structured object
   * Contract returns escrow data as array: [token, buyer, seller, arbiter, amount, ...]
   * 
   * @param escrow - Raw escrow tuple from contract readContract call
   * @returns Structured EscrowData object
   */
  private parseEscrowData(escrow: any): EscrowData {
    // Contract returns array format - access by index
    return {
      token: escrow[0] as Address,                    // Index 0
      buyer: escrow[1] as Address,                    // Index 1
      seller: escrow[2] as Address,                   // Index 2
      arbiter: escrow[3] as Address,                  // Index 3
      amount: escrow[4] as bigint,                    // Index 4
      depositTime: escrow[5] as bigint,               // Index 5
      maturityTime: escrow[6] as bigint,              // Index 6
      state: Number(escrow[7]) as EscrowState,        // Index 7
      buyerCancelRequested: escrow[8] as boolean,     // Index 8
      sellerCancelRequested: escrow[9] as boolean,    // Index 9
    };
  }


  /**
   * Build signature message WITHOUT deadline (for confirmDeliverySigned)
   * @private
   */
  private buildDeliverySignatureMessage(
    escrowId: bigint,
    buyer: Address,
    depositTime: bigint
  ): Hex {
    return keccak256(
      encodePacked(
        ["address", "uint256", "address", "uint256", "string"],
        [this.contractAddress, escrowId, buyer, depositTime, "confirmDelivery"]
      )
    );
  }

  /**
   * Build signature message WITH deadline (for other signed functions)
   * @private
   */
  private buildSignatureMessage(
    escrowId: bigint,
    participant: Address,
    depositTime: bigint,
    deadline: bigint,
    action: string,
    extraParams?: bigint[]
  ): Hex {
    const baseTypes = ["address", "uint256", "address", "uint256", "uint256", "string"];
    const baseValues: any[] = [
      this.contractAddress,
      escrowId,
      participant,
      depositTime,
      deadline,
      action
    ];

    if (extraParams && extraParams.length > 0) {
      extraParams.forEach(() => baseTypes.push("uint256"));
      baseValues.push(...extraParams);
    }

    return keccak256(encodePacked(baseTypes as any, baseValues));
  }

  /**
   * Send transaction and wait for confirmation with gas estimation
   * @private
   */
  private async sendAndConfirm(
    walletClient: WalletClient,
    functionName: string,
    args: any[] = []
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const data = encodeFunctionData({
      abi: this.abiEscrow,
      functionName,
      args,
    });

    // Gas estimation with error handling
    try {
      await this.publicClient.estimateGas({
        account: walletClient.account.address,
        to: this.contractAddress,
        data,
      });
    } catch (err: any) {
      throw new SDKError(
        `Transaction will fail: ${err.message || 'Unknown reason'}`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }

    const txHash = await walletClient.sendTransaction({
      to: this.contractAddress,
      data,
      account: walletClient.account,
      chain: this.chain,
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== 'success') {
      throw new SDKError(
        `${functionName} transaction failed or reverted`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }

    return txHash;
  }

  /**
   * Get escrow data from contract (alias for backwards compatibility)
   * @private
   */
  private async getEscrowData(escrowId: bigint): Promise<any> {
    return await this.getEscrowDataCached(escrowId);
  }


  /**
  * Safely extract account address from wallet client
  * Handles multiple account formats (string, object, json-rpc, local)
  * 
  * @param walletClient - Viem wallet client
  * @returns Account address or null if not found
  */
  private getAccountAddress(walletClient: WalletClient): Address | null {
    const account = walletClient.account;

    if (!account) {
      return null;
    }

    // Case 1: Account is a string (direct address)
    if (typeof account === 'string') {
      const addr = account as string;
      return addr.startsWith('0x') ? (addr as Address) : null;
    }

    // Case 2: Account is an object with address property
    if (typeof account === 'object') {
      // Use type assertion to bypass TypeScript's strict checking
      const accountObj = account as any;

      if (accountObj.address && typeof accountObj.address === 'string') {
        const addr = accountObj.address as string;
        return addr.startsWith('0x') ? (addr as Address) : null;
      }
    }

    // Case 3: Unable to extract address
    return null;
  }

  // ==========================================================================
  // SUBGRAPH / GRAPHQL QUERIES
  // ==========================================================================

  /**
   * Get all escrows from subgraph
   */
  async getEscrows(): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ALL_ESCROWS_QUERY
    });
    return data?.escrows ?? [];
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
   * Get escrows by buyer address
   */
  async getEscrowsByBuyer(buyer: string): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_BUYER_QUERY,
      variables: { buyer },
      fetchPolicy: "network-only"
    });
    return data?.escrows ?? [];
  }

  /**
   * Get escrows by seller address
   */
  async getEscrowsBySeller(seller: string): Promise<Escrow[]> {
    const { data } = await this.apollo.query<{ escrows: Escrow[] }>({
      query: ESCROWS_BY_SELLER_QUERY,
      variables: { seller },
      fetchPolicy: "network-only"
    });
    return data?.escrows ?? [];
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
     * Get dipute messages
  */
  async getDisputeMessages(escrowId: string): Promise<any[]> {
    const { data } = await this.apollo.query<{
      escrow: {
        disputeMessages: any[];
      };
    }>({
      query: DISPUTE_MESSAGES_BY_ESCROW_QUERY,
      variables: { escrowId },
      fetchPolicy: "network-only"
    });

    return data?.escrow?.disputeMessages ?? [];
  }

  // ==========================================================================
  // TOKEN UTILITIES
  // ==========================================================================

  /**
   * Get USDT balance for an account
   */
  async getUSDTBalanceOf(account: Address, tokenAddress: Address): Promise<bigint> {
    const balanceData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: "balanceOf",
      args: [account],
    });

    const balanceResult = await this.publicClient.call({
      to: tokenAddress,
      data: balanceData
    });

    if (!balanceResult?.data || balanceResult.data === '0x') {
      throw new SDKError('Balance call failed: No valid data returned', SDKErrorCode.TRANSACTION_FAILED);
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
   * Get token decimals
   */
  async getTokenDecimals(tokenAddress: Address): Promise<number> {
    const decimalsData = encodeFunctionData({
      abi: this.abiUSDT,
      functionName: "decimals"
    });

    const decimalsResult = await this.publicClient.call({
      to: tokenAddress,
      data: decimalsData
    });

    const [decimals] = decodeAbiParameters([{ type: "uint8" }], decimalsResult.data as Hex);
    return Number(decimals);
  }

  /**
   * Get formatted USDT balance of escrow contract
   */
  async getEscrowUSDTBalanceFormatted(tokenAddress: Address): Promise<string> {
    const rawBalance = await this.getEscrowUSDTBalance(tokenAddress);
    const decimals = await this.getTokenDecimals(tokenAddress);
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
   * Check if token is allowed by contract
   */
  async isTokenAllowed(tokenAddress: Address): Promise<boolean> {
    const result = await readContract(this.publicClient, {
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: "allowedTokens",
      args: [tokenAddress]
    });
    return result as boolean;
  }

  // ==========================================================================
  // FEE CALCULATION UTILITIES
  // ==========================================================================

  /**
   * Calculate fee and net amount with custom basis points
   */
  calculateFee(amount: bigint, customBps?: bigint): FeeCalculation {
    const bps = customBps ?? this.FEE_BPS;
    const fee = (amount * bps) / this.BPS_DENOMINATOR;
    const netAmount = amount - fee;
    return { fee, netAmount };
  }

  /**
   * Get formatted fee calculation for display
   */
  formatFeeCalculation(amount: bigint, decimals: number, customBps?: bigint): FormattedFeeCalculation {
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

  // ==========================================================================
  // MATURITY TIME UTILITIES
  // ==========================================================================

  /**
   * Calculate deadline date from deposit time and maturity days
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
   * Format maturity days for display
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
   * Get complete maturity information for an escrow
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

  /**
   * Check if auto-release is available
   */
  async canAutoRelease(escrowId: bigint): Promise<boolean> {
    const escrow = await this.getEscrowDataCached(escrowId);
    const parsed = this.parseEscrowData(escrow);

    if (parsed.state !== EscrowState.AWAITING_DELIVERY) return false;
    if (!parsed.depositTime || parsed.depositTime === 0n) return false;
    if (!parsed.maturityTime || parsed.maturityTime === 0n) return false;

    return this.isDeadlinePassed(parsed.depositTime, parsed.maturityTime);
  }

  // ==========================================================================
  // SIGNATURE UTILITIES
  // ==========================================================================

  /**
   * Create deadline timestamp for signature-based transactions
   */
  createSignatureDeadline(minutesFromNow: number = 10): bigint {
    const now = Math.floor(Date.now() / 1000);
    return BigInt(now + (minutesFromNow * 60));
  }

  /**
   * Check if signature deadline has expired
   */
  isSignatureDeadlineExpired(deadline: bigint): boolean {
    const now = Math.floor(Date.now() / 1000);
    return BigInt(now) > deadline;
  }

  // ==========================================================================
  // ESCROW STATE MANAGEMENT
  // ==========================================================================

  /**
   * Get escrow status with human-readable state name
   */
  async getEscrowStatus(escrowId: bigint): Promise<{
    stateValue: number;
    stateName: string;
    escrow: any;
  }> {
    const escrow = await this.getEscrowDataCached(escrowId);
    const stateValue = Number(escrow[7]);
    const stateNames = [
      'AWAITING_PAYMENT',
      'AWAITING_DELIVERY',
      'DISPUTED',
      'COMPLETE',
      'REFUNDED',
      'CANCELED'
    ];
    const stateName = stateNames[stateValue] || 'UNKNOWN';

    return { stateValue, stateName, escrow };
  }

  /**
   * Get UI-friendly escrow status label with color
   */
  getEscrowStatusLabel(state: EscrowState): EscrowStatusLabel {
    const labels: Record<EscrowState, EscrowStatusLabel> = {
      [EscrowState.AWAITING_PAYMENT]: {
        label: 'Awaiting Payment',
        color: 'orange',
        description: 'Buyer needs to deposit funds'
      },
      [EscrowState.AWAITING_DELIVERY]: {
        label: 'Awaiting Delivery',
        color: 'blue',
        description: 'Seller should deliver product/service'
      },
      [EscrowState.DISPUTED]: {
        label: 'Disputed',
        color: 'red',
        description: 'Dispute in progress - arbiter will resolve'
      },
      [EscrowState.COMPLETE]: {
        label: 'Complete',
        color: 'green',
        description: 'Transaction completed successfully'
      },
      [EscrowState.REFUNDED]: {
        label: 'Refunded',
        color: 'gray',
        description: 'Funds returned to buyer'
      },
      [EscrowState.CANCELED]: {
        label: 'Canceled',
        color: 'gray',
        description: 'Escrow was canceled'
      },
    };

    return labels[state];
  }

  /**
   * Check if escrow is in expected state
   */
  async isInState(escrowId: bigint, expectedState: EscrowState): Promise<boolean> {
    const { stateValue } = await this.getEscrowStatus(escrowId);
    return stateValue === expectedState;
  }

  // ==========================================================================
  // CORE ESCROW ACTIONS
  // ==========================================================================

  /**
   * Create new escrow
   */
  async createEscrow(walletClient: WalletClient, params: CreateEscrowParams) {
    assertWalletClient(walletClient);

    const maturityTimeDays = params.maturityTimeDays ?? 0n;
    const ipfsHash = params.ipfsHash ?? "";

    if (maturityTimeDays > 3650n) {
      throw new SDKError(
        "Maturity time cannot exceed 3650 days (10 years)",
        SDKErrorCode.INVALID_STATE
      );
    }

    const hash = await walletClient.writeContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'createEscrow',
      args: [
        params.token,
        params.buyer,
        params.amount,
        maturityTimeDays,
        params.title,
        ipfsHash
      ],
      account: walletClient.account,
      chain: this.chain
    });

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: 3 });

    const escrowEvents = parseEventLogs({
      abi: this.abiEscrow,
      eventName: 'EscrowCreated',
      logs: receipt.logs
    }) as Array<{ args: EscrowCreatedArgs }>;

    if (escrowEvents.length > 0) {
      const event = escrowEvents[0].args;
      return {
        escrowId: event.escrowId,
        txHash: hash,
        maturityTime: event.maturityTime
      };
    }

    throw new SDKError("EscrowCreated event not found in logs", SDKErrorCode.TRANSACTION_FAILED);
  }

  /**
   * Deposit funds into escrow (auto-fetches token and amount)
   */
  async deposit(
    walletClient: WalletClient,
    escrowId: bigint
  ): Promise<Hex> {
    // Validate wallet client
    assertWalletClient(walletClient);

    const accountAddress = this.getAccountAddress(walletClient);

    if (!accountAddress) {
      throw new SDKError(
        "Wallet account address not found. Please ensure wallet is properly connected.",
        SDKErrorCode.WALLET_ACCOUNT_MISSING
      );
    }

    const escrow = await this.getEscrowDataCached(escrowId, true);
    const parsed = this.parseEscrowData(escrow);

    // Validate caller is buyer (case-insensitive comparison)
    const normalizedCaller = accountAddress.toLowerCase();
    const normalizedBuyer = parsed.buyer.toLowerCase();

    if (normalizedCaller !== normalizedBuyer) {
      throw new SDKError(
        `Only buyer can deposit. Expected: ${parsed.buyer}, Got: ${accountAddress}`,
        SDKErrorCode.NOT_BUYER
      );
    }

    // Validate escrow state
    if (parsed.state !== EscrowState.AWAITING_PAYMENT) {
      throw new InvalidStateError(
        EscrowState[parsed.state],
        EscrowState[EscrowState.AWAITING_PAYMENT]
      );
    }

    // Validate token address
    if (!parsed.token || parsed.token === '0x0000000000000000000000000000000000000000') {
      throw new SDKError(
        "Invalid token address in escrow",
        SDKErrorCode.INVALID_ROLE
      );
    }

    // Check USDT balance
    const balance = await this.getUSDTBalanceOf(accountAddress, parsed.token);

    if (balance < parsed.amount) {
      throw new SDKError(
        `Insufficient USDT balance. Required: ${parsed.amount}, Available: ${balance}`,
        SDKErrorCode.INSUFFICIENT_BALANCE
      );
    }

    // Check current allowance
    let currentAllowance: bigint;

    try {
      const allowanceData = encodeFunctionData({
        abi: this.abiUSDT,
        functionName: "allowance",
        args: [accountAddress, this.contractAddress],
      });

      const allowanceResult = await this.publicClient.call({
        to: parsed.token,
        data: allowanceData
      });

      if (!allowanceResult?.data || allowanceResult.data === '0x') {
        throw new Error("Empty allowance response");
      }

      const [decodedAllowance] = decodeAbiParameters(
        [{ type: "uint256" }],
        allowanceResult.data as Hex
      );

      currentAllowance = decodedAllowance;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new SDKError(
        `Failed to check token allowance: ${errorMessage}`,
        SDKErrorCode.ALLOWANCE_FAILED
      );
    }

    // Handle token approval if needed
    if (currentAllowance < parsed.amount) {
      try {
        // USDT requires reset to 0 first if current allowance > 0
        // This is a known USDT quirk to prevent attack vectors
        if (currentAllowance > 0n) {
          const resetData = encodeFunctionData({
            abi: this.abiUSDT,
            functionName: "approve",
            args: [this.contractAddress, 0n],
          });

          const resetHash = await walletClient.sendTransaction({
            to: parsed.token,
            data: resetData,
            account: walletClient.account,
            chain: this.chain,
          });

          const resetReceipt = await this.publicClient.waitForTransactionReceipt({
            hash: resetHash,
            confirmations: 1
          });

          if (resetReceipt.status !== 'success') {
            throw new Error("Failed to reset USDT allowance to zero");
          }
        }

        // Approve the required amount
        const approveData = encodeFunctionData({
          abi: this.abiUSDT,
          functionName: "approve",
          args: [this.contractAddress, parsed.amount],
        });

        const approveTxHash = await walletClient.sendTransaction({
          to: parsed.token,
          data: approveData,
          account: walletClient.account,
          chain: this.chain,
        });

        const approvalReceipt = await this.publicClient.waitForTransactionReceipt({
          hash: approveTxHash,
          confirmations: 1
        });

        if (approvalReceipt.status !== 'success') {
          throw new Error("Approval transaction failed");
        }

        // Verify approval was successful
        const verifyData = encodeFunctionData({
          abi: this.abiUSDT,
          functionName: "allowance",
          args: [accountAddress, this.contractAddress],
        });

        const verifyResult = await this.publicClient.call({
          to: parsed.token,
          data: verifyData
        });

        if (verifyResult?.data && verifyResult.data !== '0x') {
          const [newAllowance] = decodeAbiParameters(
            [{ type: "uint256" }],
            verifyResult.data as Hex
          );

          if (newAllowance < parsed.amount) {
            throw new Error(`Approval verification failed. Expected: ${parsed.amount}, Got: ${newAllowance}`);
          }
        }

      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new SDKError(
          `Failed to check token allowance: ${errorMessage}`,
          SDKErrorCode.ALLOWANCE_FAILED
        );
      }
    }

    // Clear cache to ensure fresh data after deposit
    this.clearCache(escrowId);

    // Execute deposit transaction
    try {
      return await this.sendAndConfirm(walletClient, "deposit", [escrowId]);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new SDKError(
        `Deposit transaction failed: ${errorMessage}`,
        SDKErrorCode.TRANSACTION_FAILED
      );
    }
  }

  /**
   * Confirm delivery (buyer)
   */
  async confirmDelivery(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "confirmDelivery", [escrowId]);
  }

  /**
   * Confirm delivery with signature (off-chain signing)
   */
  async confirmDeliverySigned(
    walletClient: WalletClient,
    escrowId: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    const escrow = await this.getEscrowDataCached(escrowId);
    const parsed = this.parseEscrowData(escrow);

    if (walletClient.account.address.toLowerCase() !== parsed.buyer.toLowerCase()) {
      throw new SDKError('Only buyer can confirm delivery', SDKErrorCode.NOT_BUYER);
    }

    if (parsed.state !== EscrowState.AWAITING_DELIVERY) {
      throw new InvalidStateError(
        EscrowState[parsed.state],
        EscrowState[EscrowState.AWAITING_DELIVERY]
      );
    }

    const message = this.buildDeliverySignatureMessage(escrowId, parsed.buyer, parsed.depositTime);

    const signature = await walletClient.signMessage({
      account: walletClient.account,
      message: { raw: message }
    }) as Hex;

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "confirmDeliverySigned", [escrowId, signature]);
  }

  /**
   * Auto-release funds after maturity deadline
   */
  async autoRelease(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "autoRelease", [escrowId]);
  }

  // ==========================================================================
  // CANCELLATION METHODS
  // ==========================================================================

  /**
   * Request cancellation (buyer or seller)
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
    deadline: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const escrow = await this.getEscrowData(escrowId);
    const parsed = this.parseEscrowData(escrow);

    const message = this.buildSignatureMessage(
      escrowId,
      walletClient.account.address,
      parsed.depositTime,
      deadline,
      "cancelRequest"
    );

    const signature = await walletClient.signMessage({
      account: walletClient.account,
      message: { raw: message }
    }) as Hex;

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "requestCancelSigned", [
      escrowId,
      walletClient.account.address,
      deadline,
      signature
    ]);
  }

  /**
   * Cancel escrow by timeout (after cancellation request period)
   */
  async cancelByTimeout(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "cancelByTimeout", [escrowId]);
  }


  /**
 * Watch for newly created escrows for a specific user
 * Returns escrow IDs that may not yet be indexed by TheGraph
 * 
 * @param userAddress - Address of the user (buyer or seller)
 * @param callback - Function called with escrowId when new escrow is detected
 * @param options - Optional configuration
 * @returns EventWatcher with dispose method
 */
  watchUserEscrows(
    userAddress: Address,
    callback: (escrowId: bigint, event: EscrowCreatedArgs) => void,
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
      onLogs: (logs) => {
        logs.forEach((log: any) => {
          if (log.args) {
            const event = log.args as EscrowCreatedArgs;
            const isBuyer = event.buyer.toLowerCase() === normalizedAddress;
            const isSeller = event.seller.toLowerCase() === normalizedAddress;

            // Filter based on options
            if (options?.onlyAsBuyer && !isBuyer) return;
            if (options?.onlyAsSeller && !isSeller) return;

            // Only trigger if user is involved
            if (isBuyer || isSeller) {
              callback(event.escrowId, event);
            }
          }
        });
      },
      ...(options?.fromBlock && { fromBlock: options.fromBlock })
    });

    return { dispose: unwatch };
  }

  /**
   * Get basic escrow data directly from contract (fast, no subgraph)
   * Useful for displaying pending escrows before TheGraph indexes them
   * 
   * @param escrowId - The escrow ID
   * @returns Basic escrow information
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
    const stateNames = [
      'AWAITING_PAYMENT',
      'AWAITING_DELIVERY',
      'DISPUTED',
      'COMPLETE',
      'REFUNDED',
      'CANCELED'
    ];

    return {
      id: escrowId.toString(),
      buyer: parsed.buyer,
      seller: parsed.seller,
      arbiter: parsed.arbiter,
      amount: parsed.amount,
      token: parsed.token,
      state: parsed.state,
      stateName: stateNames[parsed.state],
      maturityTime: parsed.maturityTime,
      depositTime: parsed.depositTime,
      buyerCancelRequested: parsed.buyerCancelRequested,
      sellerCancelRequested: parsed.sellerCancelRequested,
    };
  }

  // ==========================================================================
  // DISPUTE METHODS
  // ==========================================================================

  /**
   * Start dispute (buyer or seller)
   */
  async startDispute(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "startDispute", [escrowId]);
  }

  /**
   * Start dispute with signature
   */
  async startDisputeSigned(
    walletClient: WalletClient,
    escrowId: bigint,
    deadline: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const escrow = await this.getEscrowData(escrowId);
    const parsed = this.parseEscrowData(escrow);

    const message = this.buildSignatureMessage(
      escrowId,
      walletClient.account.address,
      parsed.depositTime,
      deadline,
      "startDispute"
    );

    const signature = await walletClient.signMessage({
      account: walletClient.account,
      message: { raw: message }
    }) as Hex;

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "startDisputeSigned", [
      escrowId,
      walletClient.account.address,
      deadline,
      signature
    ]);
  }

  /**
   * Submit dispute message/evidence
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
   * Check if participant has submitted evidence
   */
  async hasSubmittedEvidence(escrowId: bigint, role: Role): Promise<boolean> {
    const disputeStatus = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'disputeStatus',
      args: [escrowId]
    }) as number;

    const masks: Record<Role, number> = {
      [Role.None]: 0,
      [Role.Buyer]: 1 << 0,
      [Role.Seller]: 1 << 1,
      [Role.Arbiter]: 1 << 2
    };

    return (disputeStatus & masks[role]) !== 0;
  }

  /**
   * Get dispute submission status for all participants
   */
  async getDisputeSubmissionStatus(escrowId: bigint): Promise<DisputeSubmissionStatus> {
    const disputeStatus = await this.publicClient.readContract({
      address: this.contractAddress,
      abi: this.abiEscrow,
      functionName: 'disputeStatus',
      args: [escrowId]
    }) as number;

    const buyer = (disputeStatus & (1 << 0)) !== 0;
    const seller = (disputeStatus & (1 << 1)) !== 0;
    const arbiter = (disputeStatus & (1 << 2)) !== 0;

    return {
      buyer,
      seller,
      arbiter,
      allSubmitted: buyer && seller && arbiter
    };
  }

  /**
   * Resolve dispute (arbiter)
   */
  async resolveDispute(
    walletClient: WalletClient,
    escrowId: bigint,
    resolution: DisputeResolution
  ): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "resolveDispute", [escrowId, resolution]);
  }

  /**
   * Resolve dispute with arbiter signature
   */
  async resolveDisputeSigned(
    walletClient: WalletClient,
    escrowId: bigint,
    resolution: DisputeResolution,
    deadline: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    if (resolution !== DisputeResolution.Complete && resolution !== DisputeResolution.Refunded) {
      throw new SDKError(
        "Invalid resolution. Must be Complete or Refunded",
        SDKErrorCode.INVALID_RESOLUTION
      );
    }

    const escrow = await this.getEscrowData(escrowId);
    const parsed = this.parseEscrowData(escrow);

    if (walletClient.account.address.toLowerCase() !== parsed.arbiter.toLowerCase()) {
      throw new SDKError("Only arbiter can sign dispute resolution", SDKErrorCode.NOT_ARBITER);
    }

    const message = this.buildSignatureMessage(
      escrowId,
      parsed.arbiter,
      parsed.depositTime,
      deadline,
      "resolveDispute",
      [BigInt(resolution)]
    );

    const signature = await walletClient.signMessage({
      account: walletClient.account,
      message: { raw: message }
    }) as Hex;

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "resolveDisputeSigned", [
      escrowId,
      resolution,
      deadline,
      signature
    ]);
  }

  /**
   * Refund escrow (arbiter)
   */
  async refund(walletClient: WalletClient, escrowId: bigint): Promise<Hex> {
    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "refund", [escrowId]);
  }

  /**
   * Refund with arbiter signature
   */
  async refundSigned(
    walletClient: WalletClient,
    escrowId: bigint,
    deadline: bigint
  ): Promise<Hex> {
    assertWalletClient(walletClient);

    if (this.isSignatureDeadlineExpired(deadline)) {
      throw new SignatureDeadlineExpiredError();
    }

    const escrow = await this.getEscrowData(escrowId);
    const parsed = this.parseEscrowData(escrow);

    if (walletClient.account.address.toLowerCase() !== parsed.arbiter.toLowerCase()) {
      throw new SDKError("Only arbiter can sign refund", SDKErrorCode.NOT_ARBITER);
    }

    const message = this.buildSignatureMessage(
      escrowId,
      parsed.arbiter,
      parsed.depositTime,
      deadline,
      "refund"
    );

    const signature = await walletClient.signMessage({
      account: walletClient.account,
      message: { raw: message }
    }) as Hex;

    this.clearCache(escrowId);
    return this.sendAndConfirm(walletClient, "refundSigned", [
      escrowId,
      deadline,
      signature
    ]);
  }

  // ==========================================================================
  // ADMIN METHODS (Owner only)
  // ==========================================================================

  /**
   * Set allowed token (owner only)
   */
  async setAllowedToken(
    walletClient: WalletClient,
    tokenAddress: Address,
    allowed: boolean
  ): Promise<Hex> {
    return this.sendAndConfirm(walletClient, "setAllowedToken", [tokenAddress, allowed]);
  }

  /**
   * Get contract owner address
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

  // ==========================================================================
  // EVENT WATCHERS (with EventWatcher interface)
  // ==========================================================================

  /**
   * Watch for EscrowCreated events
   */
  watchEscrowCreated(
    callback: (event: EscrowCreatedArgs) => void,
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
   * Watch for PaymentDeposited events
   */
  watchPaymentDeposited(
    callback: (event: {
      escrowId: bigint;
      buyer: Address;
      amount: bigint;
      timestamp: bigint;
    }) => void,
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
   * Watch for DisputeStarted events
   */
  watchDisputeStarted(
    callback: (event: {
      escrowId: bigint;
      initiator: Address;
      timestamp: bigint;
    }) => void,
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
   * Watch for DeliveryConfirmed events
   */
  watchDeliveryConfirmed(
    callback: (event: {
      escrowId: bigint;
      buyer: Address;
      seller: Address;
      amount: bigint;
      fee: bigint;
      timestamp: bigint;
    }) => void,
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
   * Watch for DisputeResolved events
   */
  watchDisputeResolved(
    callback: (event: {
      escrowId: bigint;
      resolution: number;
      arbiter: Address;
      amount: bigint;
      fee: bigint;
      timestamp: bigint;
    }) => void,
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
   * Watch for DisputeMessagePosted events
   */
  watchDisputeMessagePosted(
    callback: (event: {
      escrowId: bigint;
      sender: Address;
      role: number;
      ipfsHash: string;
      disputeStatus: bigint;
      timestamp: bigint;
    }) => void,
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
   * Watch for RequestCancel events
   */
  watchRequestCancel(
    callback: (event: {
      escrowId: bigint;
      requester: Address;
      timestamp: bigint;
    }) => void,
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
   * Watch for Canceled events
   */
  watchCanceled(
    callback: (event: {
      escrowId: bigint;
      initiator: Address;
      amount: bigint;
      fee: bigint;
      timestamp: bigint;
    }) => void,
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
   * Watch all events (batch registration)
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
}
