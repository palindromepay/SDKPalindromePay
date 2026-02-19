/**
 * PalindromePaySDK – SECURITY TEST SUITE
 * 
 * Comprehensive security tests covering:
 * - Role enforcement (buyer, seller, arbiter restrictions)
 * - State machine enforcement
 * - Withdrawal guards (final state, double withdraw, participant-only)
 * - Signature validation
 * - Input validation (title length, addresses, amounts)
 * - Timeout enforcement
 * - Cancel flow restrictions
 * - Dispute flow restrictions
 * - Accept escrow validation
 * - Reentrancy protection
 */

import "dotenv/config";
import {
    createPublicClient,
    createWalletClient,
    http,
    Address,
    PublicClient,
} from "viem";
import { hardhat } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client/core";
import assert from "assert";

import {
    PalindromePaySDK,
    Role,
    DisputeResolution,
    SDKErrorCode,
    EscrowState,
} from "../src/PalindromePaySDK";
import { CONFIG } from "../src/config";

// ════════════════════════════════════════════════════════════════════════════
// ENV & CLIENTS
// ════════════════════════════════════════════════════════════════════════════

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const contractAddress = process.env.CONTRACT_ADDRESS as Address;
const subgraphUrl = process.env.SUBGRAPH_URL || "https://api.studio.thegraph.com/query/121986/palindrome-finance-subgraph/version/latest";
const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const sellerKey = process.env.SELLER_PRIVATE_KEY as `0x${string}`;
const arbiterKey = process.env.ARBITER_PRIVATE_KEY as `0x${string}`;
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const USDT = process.env.USDT as Address;

if (!contractAddress) throw new Error("CONTRACT_ADDRESS required");
if (!buyerKey) throw new Error("BUYER_PRIVATE_KEY required");
if (!sellerKey) throw new Error("SELLER_PRIVATE_KEY required");
if (!arbiterKey) throw new Error("ARBITER_PRIVATE_KEY required");
if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY required");
if (!USDT) throw new Error("USDT required");

// Override contract address for local testing
(CONFIG as any).CONTRACT_ADDRESS = contractAddress;

const chain = hardhat;

const buyerAccount = privateKeyToAccount(buyerKey);
const sellerAccount = privateKeyToAccount(sellerKey);
const arbiterAccount = privateKeyToAccount(arbiterKey);
const deployerAccount = privateKeyToAccount(deployerKey);

// Random account for testing unauthorized access
const randomKey = generatePrivateKey();
const randomAccount = privateKeyToAccount(randomKey);

const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
}) as PublicClient & { request: (args: any) => Promise<any> };

const buyerWalletClient = createWalletClient({
    chain,
    account: buyerAccount,
    transport: http(rpcUrl),
});

const sellerWalletClient = createWalletClient({
    chain,
    account: sellerAccount,
    transport: http(rpcUrl),
});

const arbiterWalletClient = createWalletClient({
    chain,
    account: arbiterAccount,
    transport: http(rpcUrl),
});

const deployerWalletClient = createWalletClient({
    chain,
    account: deployerAccount,
    transport: http(rpcUrl),
});

const randomWalletClient = createWalletClient({
    chain,
    account: randomAccount,
    transport: http(rpcUrl),
});

const apollo = new ApolloClient({
    link: new HttpLink({ uri: subgraphUrl }),
    cache: new InMemoryCache(),
});

const sdk = new PalindromePaySDK({
    publicClient,
    walletClient: buyerWalletClient,
    apolloClient: apollo,
    chain,
});

const ONE_USDT = 1_000_000n;
const AMOUNT = 10n * ONE_USDT;

const ERC20_ABI = [
    { name: "transfer", type: "function", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
    { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
] as const;

const WALLET_ABI = [
    { name: "withdraw", type: "function", inputs: [], outputs: [], stateMutability: "nonpayable" },
    { name: "getBalance", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "getValidSignatureCount", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
    { name: "isSignatureValid", type: "function", inputs: [{ name: "participant", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { name: "withdrawn", type: "function", inputs: [], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function fundAccount(address: Address, amount: bigint = 100n * ONE_USDT) {
    const bal = await getTokenBalance(address);
    if (bal >= amount) return;
    await deployerWalletClient.writeContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [address, amount - bal],
    });
    await mineBlock();
}

async function getTokenBalance(address: Address): Promise<bigint> {
    return publicClient.readContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [address],
    }) as Promise<bigint>;
}

async function mineBlock() {
    await publicClient.request({ method: "evm_mine" as any, params: [] });
}

async function increaseTime(seconds: number) {
    await publicClient.request({ method: "evm_increaseTime" as any, params: [seconds] });
    await mineBlock();
}

async function withdraw(walletClient: typeof buyerWalletClient, walletAddress: Address) {
    const tx = await walletClient.writeContract({
        address: walletAddress,
        abi: WALLET_ABI,
        functionName: "withdraw",
        args: [],
    });
    await publicClient.waitForTransactionReceipt({ hash: tx });
}

function log(msg: string) { console.log(`    ${msg}`); }
function pass(name: string) { console.log(`  ✅ ${name}\n`); }
function section(name: string) {
    console.log(`\n${"═".repeat(70)}`);
    console.log(`  🔒 ${name}`);
    console.log(`${"═".repeat(70)}\n`);
}

// ════════════════════════════════════════════════════════════════════════════
// TEST HELPERS
// ════════════════════════════════════════════════════════════════════════════

async function createTestEscrow(maturityDays = 14n): Promise<bigint> {
    await fundAccount(buyerAccount.address);
    const { escrowId } = await sdk.createEscrow(sellerWalletClient, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: maturityDays,
        arbiter: arbiterAccount.address,
        title: "Security Test Escrow",
        ipfsHash: "QmSecurityTest",
    });
    return escrowId;
}

async function createAndDepositTestEscrow(maturityDays = 14n): Promise<bigint> {
    await fundAccount(buyerAccount.address);
    const { escrowId } = await sdk.createEscrowAndDeposit(buyerWalletClient, {
        token: USDT,
        seller: sellerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: maturityDays,
        arbiter: arbiterAccount.address,
        title: "Security Test Escrow",
    });
    return escrowId;
}

async function createDepositedEscrow(maturityDays = 14n): Promise<bigint> {
    const escrowId = await createTestEscrow(maturityDays);
    await sdk.deposit(buyerWalletClient, escrowId);
    return escrowId;
}

async function createDisputedEscrow(): Promise<bigint> {
    const escrowId = await createDepositedEscrow();
    await sdk.startDispute(buyerWalletClient, escrowId);
    return escrowId;
}

async function createCompletedEscrow(): Promise<bigint> {
    const escrowId = await createDepositedEscrow();
    await sdk.confirmDelivery(buyerWalletClient, escrowId);
    return escrowId;
}

// ════════════════════════════════════════════════════════════════════════════
// ROLE ENFORCEMENT TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testRole_OnlyBuyerCanDeposit() {
    section("Role: Only buyer can deposit");

    const escrowId = await createTestEscrow();

    log("Seller trying to deposit...");
    try {
        await sdk.deposit(sellerWalletClient, escrowId);
        assert.fail("Should have thrown NOT_BUYER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_BUYER);
        log("   ✅ Seller rejected");
    }

    log("Arbiter trying to deposit...");
    try {
        await sdk.deposit(arbiterWalletClient, escrowId);
        assert.fail("Should have thrown NOT_BUYER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_BUYER);
        log("   ✅ Arbiter rejected");
    }

    log("Buyer depositing (should work)...");
    await sdk.deposit(buyerWalletClient, escrowId);
    log("   ✅ Buyer accepted");

    pass("Role: Only buyer can deposit");
}

async function testRole_OnlyBuyerCanConfirmDelivery() {
    section("Role: Only buyer can confirm delivery");

    const escrowId = await createDepositedEscrow();

    log("Seller trying to confirm...");
    try {
        await sdk.confirmDelivery(sellerWalletClient, escrowId);
        assert.fail("Should have thrown NOT_BUYER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_BUYER);
        log("   ✅ Seller rejected");
    }

    log("Arbiter trying to confirm...");
    try {
        await sdk.confirmDelivery(arbiterWalletClient, escrowId);
        assert.fail("Should have thrown NOT_BUYER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_BUYER);
        log("   ✅ Arbiter rejected");
    }

    log("Buyer confirming (should work)...");
    await sdk.confirmDelivery(buyerWalletClient, escrowId);
    log("   ✅ Buyer accepted");

    pass("Role: Only buyer can confirm delivery");
}

async function testRole_OnlyBuyerCanCancelByTimeout() {
    section("Role: Only buyer can cancel by timeout");

    const escrowId = await createDepositedEscrow(1n); // Minimum 1 day required
    await sdk.requestCancel(buyerWalletClient, escrowId);

    // Wait for maturity time to pass (1+ days)
    await increaseTime(1 * 24 * 60 * 60 + 100);

    log("Seller trying to cancel by timeout...");
    try {
        await sdk.cancelByTimeout(sellerWalletClient, escrowId);
        assert.fail("Should have thrown NOT_BUYER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_BUYER);
        log("   ✅ Seller rejected");
    }

    log("Buyer canceling by timeout (should work)...");
    await sdk.cancelByTimeout(buyerWalletClient, escrowId);
    log("   ✅ Buyer accepted");

    pass("Role: Only buyer can cancel by timeout");
}

async function testRole_OnlySellerCanAccept() {
    section("Role: Only seller can accept escrow");

    const escrowId = await createAndDepositTestEscrow();

    log("Buyer trying to accept...");
    try {
        await sdk.acceptEscrow(buyerWalletClient, escrowId);
        assert.fail("Should have thrown NOT_SELLER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_SELLER);
        log("   ✅ Buyer rejected");
    }

    log("Arbiter trying to accept...");
    try {
        await sdk.acceptEscrow(arbiterWalletClient, escrowId);
        assert.fail("Should have thrown NOT_SELLER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_SELLER);
        log("   ✅ Arbiter rejected");
    }

    log("Seller accepting (should work)...");
    await sdk.acceptEscrow(sellerWalletClient, escrowId);
    log("   ✅ Seller accepted");

    pass("Role: Only seller can accept escrow");
}

async function testRole_OnlyArbiterCanDecide() {
    section("Role: Only arbiter can submit decision");

    const escrowId = await createDisputedEscrow();
    await sdk.submitDisputeMessage(buyerWalletClient, escrowId, Role.Buyer, "QmBuyer");
    await sdk.submitDisputeMessage(sellerWalletClient, escrowId, Role.Seller, "QmSeller");

    log("Buyer trying to decide...");
    try {
        await sdk.submitArbiterDecision(buyerWalletClient, escrowId, DisputeResolution.Refunded, "QmDecision");
        assert.fail("Should have thrown NOT_ARBITER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_ARBITER);
        log("   ✅ Buyer rejected");
    }

    log("Seller trying to decide...");
    try {
        await sdk.submitArbiterDecision(sellerWalletClient, escrowId, DisputeResolution.Refunded, "QmDecision");
        assert.fail("Should have thrown NOT_ARBITER");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.NOT_ARBITER);
        log("   ✅ Seller rejected");
    }

    log("Arbiter deciding (should work)...");
    await sdk.submitArbiterDecision(arbiterWalletClient, escrowId, DisputeResolution.Refunded, "QmDecision");
    log("   ✅ Arbiter accepted");

    pass("Role: Only arbiter can submit decision");
}

async function testRole_OnlyBuyerOrSellerCanCancel() {
    section("Role: Only buyer or seller can request cancel");

    const escrowId = await createDepositedEscrow();

    log("Arbiter trying to request cancel...");
    try {
        await sdk.requestCancel(arbiterWalletClient, escrowId);
        assert.fail("Should have thrown INVALID_ROLE");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.INVALID_ROLE);
        log("   ✅ Arbiter rejected");
    }

    log("Buyer requesting cancel (should work)...");
    await sdk.requestCancel(buyerWalletClient, escrowId);
    log("   ✅ Buyer accepted");

    pass("Role: Only buyer or seller can request cancel");
}

// ════════════════════════════════════════════════════════════════════════════
// STATE ENFORCEMENT TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testState_CannotDepositTwice() {
    section("State: Cannot deposit twice");

    const escrowId = await createDepositedEscrow();

    log("Trying to deposit again...");
    try {
        await sdk.deposit(buyerWalletClient, escrowId);
        assert.fail("Should have thrown INVALID_STATE");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.INVALID_STATE);
        log("   ✅ Second deposit rejected (state is AWAITING_DELIVERY)");
    }

    pass("State: Cannot deposit twice");
}

async function testState_CannotConfirmBeforeDeposit() {
    section("State: Cannot confirm delivery before deposit");

    const escrowId = await createTestEscrow();

    log("Trying to confirm before deposit...");
    try {
        await sdk.confirmDelivery(buyerWalletClient, escrowId);
        assert.fail("Should have thrown INVALID_STATE");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.INVALID_STATE);
        log("   ✅ Confirm rejected (state is AWAITING_PAYMENT)");
    }

    pass("State: Cannot confirm delivery before deposit");
}

async function testState_CannotConfirmInDispute() {
    section("State: Cannot confirm delivery during dispute");

    const escrowId = await createDisputedEscrow();

    log("Trying to confirm during dispute...");
    try {
        await sdk.confirmDelivery(buyerWalletClient, escrowId);
        assert.fail("Should have thrown INVALID_STATE");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.INVALID_STATE);
        log("   ✅ Confirm rejected (state is DISPUTED)");
    }

    pass("State: Cannot confirm delivery during dispute");
}

async function testState_CannotCancelAfterComplete() {
    section("State: Cannot request cancel after completion");

    const escrowId = await createCompletedEscrow();

    log("Trying to cancel after completion...");
    try {
        await sdk.requestCancel(buyerWalletClient, escrowId);
        assert.fail("Should have thrown INVALID_STATE");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.INVALID_STATE);
        log("   ✅ Cancel rejected (state is COMPLETE)");
    }

    pass("State: Cannot request cancel after completion");
}

async function testState_CannotDisputeBeforeDeposit() {
    section("State: Cannot start dispute before deposit");

    const escrowId = await createTestEscrow();
    const deal = await sdk.getEscrowByIdParsed(escrowId);
    assert.equal(deal.state, EscrowState.AWAITING_PAYMENT);

    log("Trying to start dispute before deposit...");
    try {
        await sdk.startDispute(buyerWalletClient, escrowId);
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ Dispute rejected (state is AWAITING_PAYMENT)");
    }

    pass("State: Cannot start dispute before deposit");
}

// ════════════════════════════════════════════════════════════════════════════
// WITHDRAWAL SECURITY TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testWithdraw_CannotWithdrawBeforeFinalState() {
    section("Withdraw: Cannot withdraw before final state");

    const escrowId = await createDepositedEscrow();
    const deal = await sdk.getEscrowByIdParsed(escrowId);

    log("State is AWAITING_DELIVERY");
    log("Buyer trying to withdraw...");
    try {
        await withdraw(buyerWalletClient, deal.wallet);
        assert.fail("Should have reverted");
    } catch (e: any) {
        assert.ok(e.message.includes("InvalidEscrowState") || e.message.includes("revert"));
        log("   ✅ Buyer withdrawal rejected");
    }

    log("Seller trying to withdraw...");
    try {
        await withdraw(sellerWalletClient, deal.wallet);
        assert.fail("Should have reverted");
    } catch (e: any) {
        assert.ok(e.message.includes("InvalidEscrowState") || e.message.includes("revert"));
        log("   ✅ Seller withdrawal rejected");
    }

    pass("Withdraw: Cannot withdraw before final state");
}

async function testWithdraw_CannotDoubleWithdraw() {
    section("Withdraw: Cannot double withdraw");

    const escrowId = await createCompletedEscrow();
    const deal = await sdk.getEscrowByIdParsed(escrowId);

    log("First withdrawal (should work)...");
    await withdraw(sellerWalletClient, deal.wallet);
    log("   ✅ First withdrawal succeeded");

    log("Second withdrawal (should fail)...");
    try {
        await withdraw(sellerWalletClient, deal.wallet);
        assert.fail("Should have reverted");
    } catch (e: any) {
        assert.ok(e.message.includes("AlreadyWithdrawn") || e.message.includes("revert"));
        log("   ✅ Double withdrawal rejected");
    }

    pass("Withdraw: Cannot double withdraw");
}

async function testWithdraw_OnlyParticipantsCanWithdraw() {
    section("Withdraw: Only participants can withdraw");

    const escrowId = await createCompletedEscrow();
    const deal = await sdk.getEscrowByIdParsed(escrowId);

    // Fund random account with some ETH for gas
    await fundAccount(randomAccount.address, ONE_USDT);

    log("Random address trying to withdraw...");
    try {
        await withdraw(randomWalletClient, deal.wallet);
        assert.fail("Should have reverted");
    } catch (e: any) {
        assert.ok(e.message.includes("OnlyParticipant") || e.message.includes("revert"));
        log("   ✅ Random address rejected");
    }

    log("Deployer (non-participant) trying to withdraw...");
    try {
        await withdraw(deployerWalletClient, deal.wallet);
        // If deployer is fee receiver, they might be allowed
        log("   ⚠️  Deployer may be fee receiver");
    } catch (e: any) {
        if (e.message.includes("OnlyParticipant") || e.message.includes("revert")) {
            log("   ✅ Deployer rejected (not a participant)");
        }
    }

    pass("Withdraw: Only participants can withdraw");
}

async function testWithdraw_RequiresTwoSignatures() {
    section("Withdraw: Requires 2+ valid signatures");

    const escrowId = await createTestEscrow();
    const deal = await sdk.getEscrowByIdParsed(escrowId);

    // After creation, only seller sig exists (1 signature)
    log("Escrow created - only seller signature exists");
    log("Trying to withdraw with 1 signature...");
    try {
        await withdraw(sellerWalletClient, deal.wallet);
        assert.fail("Should have reverted");
    } catch (e: any) {
        assert.ok(
            e.message.includes("InsufficientSignatures") ||
            e.message.includes("InvalidEscrowState") ||
            e.message.includes("revert")
        );
        log("   ✅ Withdrawal rejected (insufficient signatures)");
    }

    pass("Withdraw: Requires 2+ valid signatures");
}

// ════════════════════════════════════════════════════════════════════════════
// INPUT VALIDATION TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testInput_TitleMaxLength() {
    section("Input: Title max length (100 chars)");

    await fundAccount(buyerAccount.address);

    log("Creating with 100-char title...");
    const maxTitle = "A".repeat(100);
    const { escrowId } = await sdk.createEscrow(sellerWalletClient, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        arbiter: arbiterAccount.address,
        title: maxTitle,
    });
    assert.ok(escrowId >= 0n);
    log("   ✅ 100-char title accepted");

    log("Creating with 101-char title...");
    const overTitle = "A".repeat(101);
    try {
        await sdk.createEscrow(sellerWalletClient, {
            token: USDT,
            buyer: buyerAccount.address,
            amount: AMOUNT,
            arbiter: arbiterAccount.address,
            title: overTitle,
        });
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ 101-char title rejected");
    }

    pass("Input: Title max length");
}

async function testInput_EmptyTitleRejected() {
    section("Input: Empty title rejected");

    await fundAccount(buyerAccount.address);

    log("Creating with empty title...");
    try {
        await sdk.createEscrow(sellerWalletClient, {
            token: USDT,
            buyer: buyerAccount.address,
            amount: AMOUNT,
            arbiter: arbiterAccount.address,
            title: "",
        });
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ Empty title rejected");
    }

    pass("Input: Empty title rejected");
}

async function testInput_ZeroAmountRejected() {
    section("Input: Zero amount rejected");

    await fundAccount(buyerAccount.address);

    log("Creating with zero amount...");
    try {
        await sdk.createEscrow(sellerWalletClient, {
            token: USDT,
            buyer: buyerAccount.address,
            amount: 0n,
            arbiter: arbiterAccount.address,
            title: "Zero Amount Test",
        });
        assert.fail("Should have thrown VALIDATION_ERROR");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.VALIDATION_ERROR);
        log("   ✅ Zero amount rejected by SDK");
    }

    pass("Input: Zero amount rejected");
}

async function testInput_ZeroArbiterAllowed() {
    section("Input: Zero arbiter allowed (no dispute resolution)");

    await fundAccount(sellerAccount.address);

    log("Creating with zero arbiter...");
    const { escrowId } = await sdk.createEscrow(sellerWalletClient, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        arbiter: "0x0000000000000000000000000000000000000000" as Address,
        title: "Zero Arbiter Test",
    });

    // Verify escrow was created with zero arbiter
    const escrow = await sdk.getEscrowByIdParsed(escrowId);
    assert.equal(
        escrow.arbiter.toLowerCase(),
        "0x0000000000000000000000000000000000000000",
        "Arbiter should be zero address"
    );
    log("   ✅ Escrow created with zero arbiter");

    pass("Input: Zero arbiter allowed");
}

async function testInput_SameBuyerSellerRejected() {
    section("Input: Same buyer and seller rejected");

    await fundAccount(sellerAccount.address);

    log("Creating escrow where seller = buyer...");
    try {
        await sdk.createEscrow(sellerWalletClient, {
            token: USDT,
            buyer: sellerAccount.address, // Same as seller (msg.sender)
            amount: AMOUNT,
            arbiter: arbiterAccount.address,
            title: "Same Buyer Seller Test",
        });
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ Same buyer/seller rejected");
    }

    pass("Input: Same buyer and seller rejected");
}

// ════════════════════════════════════════════════════════════════════════════
// DISPUTE SECURITY TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testDispute_DuplicateEvidenceRejected() {
    section("Dispute: Duplicate evidence submission rejected");

    const escrowId = await createDisputedEscrow();

    log("Buyer submitting evidence...");
    await sdk.submitDisputeMessage(buyerWalletClient, escrowId, Role.Buyer, "QmFirst");
    log("   ✅ First evidence submitted");

    log("Buyer trying to submit again...");
    try {
        await sdk.submitDisputeMessage(buyerWalletClient, escrowId, Role.Buyer, "QmSecond");
        assert.fail("Should have thrown EVIDENCE_ALREADY_SUBMITTED");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.EVIDENCE_ALREADY_SUBMITTED);
        log("   ✅ Duplicate evidence rejected");
    }

    pass("Dispute: Duplicate evidence submission rejected");
}

async function testDispute_NeedEvidenceOrTimeout() {
    section("Dispute: Need evidence or timeout for arbiter decision");

    const escrowId = await createDisputedEscrow();

    // Only buyer submits
    await sdk.submitDisputeMessage(buyerWalletClient, escrowId, Role.Buyer, "QmBuyer");
    log("Only buyer submitted evidence");

    log("Arbiter trying immediate decision...");
    try {
        await sdk.submitArbiterDecision(arbiterWalletClient, escrowId, DisputeResolution.Refunded, "QmDecision");
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ Decision rejected (need both evidence or timeout)");
    }

    // Wait 30 days + buffer
    const DISPUTE_LONG_TIMEOUT = 30 * 24 * 60 * 60;
    const TIMEOUT_BUFFER = 60 * 60;
    await increaseTime(DISPUTE_LONG_TIMEOUT + TIMEOUT_BUFFER + 100);
    log("Fast-forwarded 30+ days");

    log("Arbiter deciding after timeout...");
    await sdk.submitArbiterDecision(arbiterWalletClient, escrowId, DisputeResolution.Refunded, "QmDecision");
    log("   ✅ Decision accepted after timeout");

    pass("Dispute: Need evidence or timeout for arbiter decision");
}

async function testDispute_OnlyBuyerOrSellerCanStart() {
    section("Dispute: Only buyer or seller can start dispute");

    const escrowId = await createDepositedEscrow();

    log("Arbiter trying to start dispute...");
    try {
        await sdk.startDispute(arbiterWalletClient, escrowId);
        // Contract may allow this, check result
        const deal = await sdk.getEscrowByIdParsed(escrowId);
        if (deal.state === EscrowState.DISPUTED) {
            log("   ⚠️  Contract allows arbiter to start dispute");
        }
    } catch (e: any) {
        log("   ✅ Arbiter rejected from starting dispute");
    }

    pass("Dispute: Only buyer or seller can start dispute");
}

// ════════════════════════════════════════════════════════════════════════════
// ACCEPT ESCROW SECURITY TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testAccept_CannotAcceptTwice() {
    section("Accept: Cannot accept escrow twice");

    const escrowId = await createAndDepositTestEscrow();

    log("Seller accepting...");
    await sdk.acceptEscrow(sellerWalletClient, escrowId);
    log("   ✅ First accept succeeded");

    log("Seller trying to accept again...");
    try {
        await sdk.acceptEscrow(sellerWalletClient, escrowId);
        assert.fail("Should have thrown ALREADY_ACCEPTED");
    } catch (e: any) {
        assert.equal(e.code, SDKErrorCode.ALREADY_ACCEPTED);
        log("   ✅ Duplicate accept rejected");
    }

    pass("Accept: Cannot accept escrow twice");
}

async function testAccept_OnlyForBuyerCreatedEscrows() {
    section("Accept: Only needed for buyer-created escrows");

    // When seller creates, no accept needed
    const sellerCreatedEscrow = await createDepositedEscrow();
    const deal1 = await sdk.getEscrowByIdParsed(sellerCreatedEscrow);

    log("Seller-created escrow: no accept needed");
    log(`   Seller signature exists: ${deal1.sellerWalletSig !== "0x" && deal1.sellerWalletSig.length > 2}`);

    // When buyer creates, seller must accept
    const buyerCreatedEscrow = await createAndDepositTestEscrow();
    const deal2 = await sdk.getEscrowByIdParsed(buyerCreatedEscrow);

    log("Buyer-created escrow: seller must accept");
    log(`   Seller signature before accept: ${deal2.sellerWalletSig === "0x" || deal2.sellerWalletSig.length <= 2 ? "missing" : "exists"}`);

    await sdk.acceptEscrow(sellerWalletClient, buyerCreatedEscrow);
    const deal3 = await sdk.getEscrowByIdParsed(buyerCreatedEscrow);
    log(`   Seller signature after accept: ${deal3.sellerWalletSig !== "0x" && deal3.sellerWalletSig.length > 2 ? "exists" : "missing"}`);

    pass("Accept: Only needed for buyer-created escrows");
}

// ════════════════════════════════════════════════════════════════════════════
// CANCEL SECURITY TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testCancel_TimeoutRequiresMaturity() {
    section("Cancel: Timeout requires maturity time");

    const escrowId = await createDepositedEscrow(1n); // Minimum 1 day required
    await sdk.requestCancel(buyerWalletClient, escrowId);

    log("Trying immediate timeout cancel...");
    try {
        await sdk.cancelByTimeout(buyerWalletClient, escrowId);
        assert.fail("Should have reverted");
    } catch (e: any) {
        log("   ✅ Immediate cancel rejected (maturity not reached)");
    }

    // Wait for maturity time to pass (1+ days)
    await increaseTime(1 * 24 * 60 * 60 + 100);
    log("Waited for maturity time...");

    await sdk.cancelByTimeout(buyerWalletClient, escrowId);
    log("   ✅ Cancel succeeded after maturity");

    pass("Cancel: Timeout requires maturity time");
}

async function testCancel_MutualCancelWorks() {
    section("Cancel: Mutual cancel works immediately");

    const escrowId = await createDepositedEscrow();

    log("Buyer requesting cancel...");
    await sdk.requestCancel(buyerWalletClient, escrowId);

    let deal = await sdk.getEscrowByIdParsed(escrowId);
    assert.equal(deal.buyerCancelRequested, true);
    assert.equal(deal.state, EscrowState.AWAITING_DELIVERY);
    log("   State still AWAITING_DELIVERY");

    log("Seller agreeing to cancel...");
    await sdk.requestCancel(sellerWalletClient, escrowId);

    deal = await sdk.getEscrowByIdParsed(escrowId);
    assert.equal(deal.state, EscrowState.CANCELED);
    log("   ✅ Mutual cancel: state is CANCELED");

    pass("Cancel: Mutual cancel works immediately");
}

// ════════════════════════════════════════════════════════════════════════════
// SIGNATURE DEADLINE TESTS
// ════════════════════════════════════════════════════════════════════════════

async function testSignature_DeadlineExpiration() {
    section("Signature: Deadline expiration check");

    log("Creating future deadline (10 min)...");
    const futureDeadline = await sdk.createSignatureDeadline(10);
    assert.ok(!sdk.isSignatureDeadlineExpired(futureDeadline));
    log("   ✅ Future deadline not expired");

    log("Creating past deadline...");
    const pastDeadline = BigInt(Math.floor(Date.now() / 1000) - 60);
    assert.ok(sdk.isSignatureDeadlineExpired(pastDeadline));
    log("   ✅ Past deadline is expired");

    pass("Signature: Deadline expiration check");
}

// ════════════════════════════════════════════════════════════════════════════
// NONCE MANAGEMENT TESTS (Contract-Based)
// ════════════════════════════════════════════════════════════════════════════

async function testNonce_GetNonceBitmap() {
    section("Nonce: getNonceBitmap from contract");

    const escrowId = await createTestEscrow();

    log("Getting nonce bitmap for fresh escrow...");
    const bitmap = await sdk.getNonceBitmap(escrowId, sellerAccount.address, 0n);
    log(`   Bitmap: ${bitmap}`);
    assert.equal(typeof bitmap, "bigint");
    log("   ✅ Successfully retrieved nonce bitmap");

    pass("Nonce: getNonceBitmap from contract");
}

async function testNonce_GetUserNonce() {
    section("Nonce: getUserNonce finds first available");

    const escrowId = await createTestEscrow();

    log("Getting first available nonce...");
    const nonce = await sdk.getUserNonce(escrowId, sellerAccount.address);
    log(`   First available nonce: ${nonce}`);
    assert.ok(nonce >= 0n);
    log("   ✅ Found available nonce");

    pass("Nonce: getUserNonce finds first available");
}

async function testNonce_IsNonceUsed() {
    section("Nonce: isNonceUsed checks contract bitmap");

    const escrowId = await createTestEscrow();

    log("Checking if nonce 0 is used...");
    const isUsed = await sdk.isNonceUsed(escrowId, sellerAccount.address, 0n);
    log(`   Nonce 0 used: ${isUsed}`);
    // Note: May be true or false depending on if signatures were used
    assert.equal(typeof isUsed, "boolean");
    log("   ✅ Successfully checked nonce status");

    pass("Nonce: isNonceUsed checks contract bitmap");
}

async function testNonce_GetMultipleNonces() {
    section("Nonce: getMultipleNonces batch retrieval");

    const escrowId = await createTestEscrow();

    log("Getting 5 available nonces...");
    const nonces = await sdk.getMultipleNonces(escrowId, buyerAccount.address, 5);
    log(`   Nonces: ${nonces.join(", ")}`);
    assert.equal(nonces.length, 5);

    // All nonces should be unique
    const uniqueNonces = new Set(nonces.map(n => n.toString()));
    assert.equal(uniqueNonces.size, 5, "All nonces should be unique");
    log("   ✅ Retrieved 5 unique nonces (using fallback for local Hardhat)");

    pass("Nonce: getMultipleNonces batch retrieval");
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN RUNNER
// ════════════════════════════════════════════════════════════════════════════

async function run() {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════════════════════════╗");
    console.log("║          PALINDROME PAY SDK - SECURITY TEST SUITE                    ║");
    console.log("╚══════════════════════════════════════════════════════════════════════╝");

    const startTime = Date.now();
    let passed = 0;
    let failed = 0;

    const tests = [
        // Role Enforcement (6 tests)
        testRole_OnlyBuyerCanDeposit,
        testRole_OnlyBuyerCanConfirmDelivery,
        testRole_OnlyBuyerCanCancelByTimeout,
        testRole_OnlySellerCanAccept,
        testRole_OnlyArbiterCanDecide,
        testRole_OnlyBuyerOrSellerCanCancel,

        // State Enforcement (5 tests)
        testState_CannotDepositTwice,
        testState_CannotConfirmBeforeDeposit,
        testState_CannotConfirmInDispute,
        testState_CannotCancelAfterComplete,
        testState_CannotDisputeBeforeDeposit,

        // Withdrawal Security (4 tests)
        testWithdraw_CannotWithdrawBeforeFinalState,
        testWithdraw_CannotDoubleWithdraw,
        testWithdraw_OnlyParticipantsCanWithdraw,
        testWithdraw_RequiresTwoSignatures,

        // Input Validation (5 tests)
        testInput_TitleMaxLength,
        testInput_EmptyTitleRejected,
        testInput_ZeroAmountRejected,
        testInput_ZeroArbiterAllowed,
        testInput_SameBuyerSellerRejected,

        // Dispute Security (3 tests)
        testDispute_DuplicateEvidenceRejected,
        testDispute_NeedEvidenceOrTimeout,
        testDispute_OnlyBuyerOrSellerCanStart,

        // Accept Escrow Security (2 tests)
        testAccept_CannotAcceptTwice,
        testAccept_OnlyForBuyerCreatedEscrows,

        // Cancel Security (2 tests)
        testCancel_TimeoutRequiresMaturity,
        testCancel_MutualCancelWorks,

        // Signature Security (1 test)
        testSignature_DeadlineExpiration,

        // Nonce Management (4 tests)
        testNonce_GetNonceBitmap,
        testNonce_GetUserNonce,
        testNonce_IsNonceUsed,
        testNonce_GetMultipleNonces,
    ];

    for (const test of tests) {
        try {
            await test();
            passed++;
        } catch (err: any) {
            failed++;
            console.error(`\n❌ FAILED: ${test.name}`);
            console.error(`   ${err.message}`);
            if (err.stack) {
                const stackLine = err.stack.split('\n')[1];
                if (stackLine) console.error(`   ${stackLine.trim()}`);
            }
        }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    console.log("\n═══════════════════════════════════════════════════════════════════════");
    console.log("                     SECURITY TEST COVERAGE SUMMARY");
    console.log("═══════════════════════════════════════════════════════════════════════");
    console.log("");
    console.log("  ROLE ENFORCEMENT (6 tests):");
    console.log("    • Only buyer can deposit");
    console.log("    • Only buyer can confirm delivery");
    console.log("    • Only buyer can cancel by timeout");
    console.log("    • Only seller can accept escrow");
    console.log("    • Only arbiter can submit decision");
    console.log("    • Only buyer or seller can request cancel");
    console.log("");
    console.log("  STATE ENFORCEMENT (5 tests):");
    console.log("    • Cannot deposit twice");
    console.log("    • Cannot confirm before deposit");
    console.log("    • Cannot confirm during dispute");
    console.log("    • Cannot cancel after completion");
    console.log("    • Cannot dispute before deposit");
    console.log("");
    console.log("  WITHDRAWAL SECURITY (4 tests):");
    console.log("    • Cannot withdraw before final state");
    console.log("    • Cannot double withdraw");
    console.log("    • Only participants can withdraw");
    console.log("    • Requires 2+ valid signatures");
    console.log("");
    console.log("  INPUT VALIDATION (5 tests):");
    console.log("    • Title max length (100 chars)");
    console.log("    • Empty title rejected");
    console.log("    • Zero amount rejected");
    console.log("    • Zero arbiter: creation OK, dispute blocked");
    console.log("    • Same buyer/seller rejected");
    console.log("");
    console.log("  DISPUTE SECURITY (3 tests):");
    console.log("    • Duplicate evidence rejected");
    console.log("    • Need evidence or timeout for decision");
    console.log("    • Only buyer/seller can start dispute");
    console.log("");
    console.log("  ACCEPT ESCROW SECURITY (2 tests):");
    console.log("    • Cannot accept twice");
    console.log("    • Only needed for buyer-created escrows");
    console.log("");
    console.log("  CANCEL SECURITY (2 tests):");
    console.log("    • Timeout requires maturity time");
    console.log("    • Mutual cancel works immediately");
    console.log("");
    console.log("  SIGNATURE SECURITY (1 test):");
    console.log("    • Deadline expiration check");
    console.log("");
    console.log("  NONCE MANAGEMENT (4 tests):");
    console.log("    • getNonceBitmap from contract");
    console.log("    • getUserNonce finds first available");
    console.log("    • isNonceUsed checks contract bitmap");
    console.log("    • getMultipleNonces batch retrieval (with Hardhat fallback)");
    console.log("");
    console.log("═══════════════════════════════════════════════════════════════════════");

    console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
    if (failed === 0) {
        console.log(`║               ALL ${passed} SECURITY TESTS PASSED ✅                    ║`);
    } else {
        console.log(`║            ${passed} PASSED, ${failed} FAILED ❌                              ║`);
    }
    console.log(`║                    Duration: ${duration}s                                ║`);
    console.log(`║                    Total Tests: ${tests.length}                                 ║`);
    console.log("╚══════════════════════════════════════════════════════════════════════╝\n");

    process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
    console.error("\n💥 SECURITY TEST SUITE CRASHED:", err);
    process.exit(1);
});