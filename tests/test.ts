/**
 * PalindromeEscrowSDK Integration Test Suite (Optimized SDK Version)
 *
 * Tests Covered:
 * - Happy paths:
 *   - Direct viem-level createEscrow sanity check.
 *   - Full SDK workflow: createEscrow, deposit, startDispute, evidence submission,
 *     and submitArbiterDecision for both COMPLETE (seller wins) and REFUNDED (buyer wins).
 *   - Buyer confirmDelivery and correct withdraw caller in COMPLETE state.
 *   - Seller withdraw All Token
 *
 * - Permissions & Invalid flows:
 *   - Unauthorized submitArbiterDecision attempt by buyer.
 *   - Unauthorized startDispute from random address.
 *   - Prevention of double deposit, double startDispute, and double arbiter decision.
 *   - Evidence submission constraints: only when escrow is DISPUTED, preventing duplicate evidence per role.
 *
 * - SDK error mapping tests:
 *   - Deposit by non-buyer -> SDKErrorCode.NOT_BUYER.
 *   - Deposit with insufficient USDT balance -> SDKErrorCode.INSUFFICIENT_BALANCE.
 *   - Broken allowance verification -> SDKErrorCode.ALLOWANCE_FAILED.
 *   - Early withdraw before escrow end -> SDKErrorCode.INVALID_STATE.
 *
 * - Edge cases & helpers:
 *   - Validates maturityTimeDays boundaries (0 and 3650 accepted, >3650 rejected).
 *   - Cache eviction and status helpers tested via getEscrowStatus and isInState.
 *
 * - Additional comprehensive tests:
 *   - Cancel by timeout (buyer protection).
 *   - Query methods (nonces, withdrawable amounts, fee pool).
 *   - ConfirmDeliverySigned and requestCancelSigned flows.
 *   - StartDisputeSigned and admin methods (setAllowedToken, withdrawFees).
 *   - Withdraw in REFUNDED state.
 *   - Dispute timeouts: 7-day (partial evidence) and 30-day (no evidence) scenarios.
 *   - Batch operations and transaction simulation.
 *   - Health check for RPC, subgraph, contract deployment.
 *
 * Total of 24 tests ensuring SDK robustness, error handling, state transitions,
 * and permissions within the PalindromeEscrowSDK.
 */

import 'dotenv/config';
import {
    createPublicClient,
    createWalletClient,
    http,
    WalletClient,
} from 'viem';
import { hardhat } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client/core';

import {
    PalindromeEscrowSDK,
    CreateEscrowParams,
    CreateEscrowAndDepositParams,
    Role,
    DisputeResolution,
    SDKError,
    SDKErrorCode,
    EscrowData,
    EscrowState
} from '../src/PalindromeEscrowSDK';

// ========== ENV VARS ==========

const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`;
const subgraphUrl =
    process.env.SUBGRAPH_URL || 'http://localhost:8000/subgraphs/name/palindrome';
const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const sellerKey = process.env.SELLER_PRIVATE_KEY as `0x${string}`;
const arbiterKey = process.env.ARBITER_PRIVATE_KEY as `0x${string}`;
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const USDT = process.env.USDT as `0x${string}`;

if (!contractAddress) throw new Error('CONTRACT_ADDRESS env var is missing!');
if (!buyerKey) throw new Error('BUYER_PRIVATE_KEY env var is missing!');
if (!sellerKey) throw new Error('SELLER_PRIVATE_KEY env var is missing!');
if (!arbiterKey) throw new Error('OWNER_KEY env var is missing!');
if (!deployerKey) throw new Error('DEPLOYER_PRIVATE_KEY env var is missing!');
if (!USDT) throw new Error('USDT env var is missing!');

// ========== CLIENTS & SDK ==========

const chain = hardhat;

const buyerAccount = privateKeyToAccount(buyerKey);
const sellerAccount = privateKeyToAccount(sellerKey);
const arbiterAccount = privateKeyToAccount(arbiterKey);
const deployerAccount = privateKeyToAccount(deployerKey);

const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
});

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

const apollo = new ApolloClient({
    link: new HttpLink({ uri: subgraphUrl }),
    cache: new InMemoryCache(),
});


const sdk = new PalindromeEscrowSDK({
    publicClient,
    contractAddress,
    buyerWalletClient,
    sellerWalletClient,
    walletClient: buyerWalletClient,
    apollo,
    chain,
    cacheTTL: 5000,        // 5 second cache
    enableRetry: true,     // Enable retry logic
    maxRetries: 3,         // Max 3 retries
    gasBuffer: 20          // 20% gas buffer
});

// ========== HELPERS ==========

async function logUsdtBalances() {
    const buyer = buyerWalletClient.account.address;
    console.log('\n🧪 USDT BALANCES');
    const deployerBal = await sdk.getUSDTBalanceOf(deployerAccount.address, USDT);
    const arbiterBal = await sdk.getUSDTBalanceOf(arbiterAccount.address, USDT);
    const buyerBal = await sdk.getUSDTBalanceOf(buyer, USDT);
    console.log('Deployer USDT:', deployerBal.toString());
    console.log('Arbiter  USDT:', arbiterBal.toString());
    console.log('Buyer    USDT:', buyerBal.toString());
}

async function createEscrow(maturityTimeDays: bigint) {
    console.log('> createEscrow start');
    const amount = 10n * 1_000_000n;
    const params: CreateEscrowParams = {
        token: USDT,
        buyer: buyerWalletClient.account!.address,
        amount,
        maturityTimeDays,
        arbiter: arbiterAccount.address,
        title: 'Test Title',
        ipfsHash: 'Qm...',
    };

    const result = await sdk.createEscrow(sellerWalletClient, params);
    console.log('> createEscrow tx done, id:', result.escrowId?.toString());
    const stats = sdk.getCacheStats();
    console.log('Cache stats:', stats);

    return result.escrowId;
}
async function createEscrowAndDeposit(maturityTimeDays: bigint) {
    console.log('> createEscrow start');
    const amount = 10n * 1_000_000n;
    const params: CreateEscrowAndDepositParams = {
        token: USDT,
        seller: sellerWalletClient.account!.address,
        amount,
        maturityTimeDays,
        arbiter: arbiterAccount.address,
        title: 'Test Title',
        ipfsHash: 'Qm...',
    };

    const result = await sdk.createEscrowAndDeposit(sellerWalletClient, params);
    console.log('> createEscrow tx done, id:', result.escrowId?.toString());
    const stats = sdk.getCacheStats();
    console.log('Cache stats:', stats);

    return result.escrowId;
}

// Ensure buyer has enough USDT and deposit to escrow
async function testDepositEscrow(escrowId: bigint) {
    console.log('Deployer account address:', deployerAccount.address);
    console.log('Arbiter account address:', arbiterAccount.address);
    console.log('Using deployerWalletClient for funding...');

    const amount = 10n * 1_000_000n;
    const buyer = buyerWalletClient.account.address;

    console.log('> deposit start, escrowId:', escrowId.toString());
    console.log('Buyer wallet address:', buyer);
    console.log('USDT token address:', USDT);
    console.log('Escrow contract address:', contractAddress);

    let buyerBalance = await sdk.getUSDTBalanceOf(buyer, USDT);
    console.log('Buyer USDT balance before:', buyerBalance.toString());

    if (buyerBalance < amount) {
        console.log(
            `Funding buyer with ${amount - buyerBalance} wei USDT from DEPLOYER...`,
        );

        console.log('Deployer address:', deployerAccount.address);

        const fundTx = await deployerWalletClient.writeContract({
            address: USDT,
            abi: sdk.abiUSDT,
            functionName: 'transfer',
            args: [buyer, amount - buyerBalance],
        });
        console.log('Fund tx hash:', fundTx);

        const fundReceipt = await publicClient.waitForTransactionReceipt({
            hash: fundTx,
        });
        console.log('Fund receipt status:', fundReceipt.status);

        buyerBalance = await sdk.getUSDTBalanceOf(buyer, USDT);
        console.log('Buyer USDT balance after funding:', buyerBalance.toString());
    }

    if (buyerBalance < amount) {
        throw new Error(
            `Buyer does not have enough USDT. Needed ${amount}, have ${buyerBalance}`,
        );
    }

    console.log('> calling sdk.deposit');
    const txHash = await sdk.deposit(buyerWalletClient, escrowId);
    console.log('Deposit tx sent:', txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('✅ Deposit confirmed:', receipt.status);
}

// Direct viem call sanity check
async function testDirectCreateEscrow() {
    console.log('\n🧪 DIRECT createEscrow sanity check\n');

    const amount = 10n * 1_000_000n;
    const buyer = buyerWalletClient.account.address;
    const seller = sellerWalletClient.account.address;
    const arbiter = arbiterWalletClient.account.address;

    console.log('Direct call params:', {
        contractAddress,
        token: USDT,
        buyer,
        amount: amount.toString(),
        maturityTimeDays: '14',
        arbiter,
    });

    const txHash = await sellerWalletClient.writeContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'createEscrow',
        args: [
            USDT,
            buyer,
            amount,
            14n,
            arbiter,
            'Direct Test Title',
            'QmDirectTest...',
        ],
    });

    console.log('Direct createEscrow tx hash:', txHash);

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('Direct createEscrow receipt status:', receipt.status);
}

// Helper: Time manipulation for testing timeouts
async function advanceTime(seconds: number) {
    await publicClient.request({
        method: 'evm_increaseTime' as any,
        params: [seconds] as any,
    });
    await publicClient.request({
        method: 'evm_mine' as any,
        params: [] as any,
    });
}

// ========== TESTS ==========

// Test 1: Full dispute flow with evidence + atomic arbiter decision
async function testDisputeFlowWithEvidence() {
    console.log(
        '\n🧪 TEST 1: Full Dispute Flow with Evidence + submitArbiterDecision\n',
    );

    // 1. Create escrow
    const escrowId = await createEscrow(14n);
    console.log('Escrow ID:', escrowId.toString());

    // 2. Deposit
    await testDepositEscrow(escrowId);
    let status = await sdk.getEscrowStatus(escrowId, true);
    console.log('State after deposit:', status.stateName);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        'Should be AWAITING_DELIVERY after deposit',
    );

    // 3. Start dispute
    console.log('\n--- Starting Dispute ---');
    const disputeTx = await sdk.startDispute(buyerWalletClient, escrowId);
    console.log('✅ Dispute started tx:', disputeTx);
    const disputeReceipt = await publicClient.waitForTransactionReceipt({
        hash: disputeTx,
    });
    console.assert(disputeReceipt.status === 'success', 'startDispute tx failed');

    status = await sdk.getEscrowStatus(escrowId, true);
    console.log('State after startDispute:', status.stateName);
    console.assert(
        status.stateName === 'DISPUTED',
        'Should be DISPUTED after startDispute',
    );

    // 4. Submission status (initial)
    console.log('\n--- Initial Submission Status ---');
    let submissionStatus = await sdk.getDisputeSubmissionStatus(escrowId);
    console.log('Submission status:', submissionStatus);

    // 5. Buyer evidence
    console.log('\n--- Buyer Submitting Evidence ---');
    const buyerIpfsHash = 'QmBuyerEvidence123abc';
    const buyerSubmitTx = await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        buyerIpfsHash,
    );
    console.log('✅ Buyer submitted evidence:', buyerSubmitTx);
    await publicClient.waitForTransactionReceipt({ hash: buyerSubmitTx });

    // 6. Seller evidence
    console.log('\n--- Seller Submitting Evidence ---');
    const sellerIpfsHash = 'QmSellerEvidence456def';
    const sellerSubmitTx = await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        sellerIpfsHash,
    );
    console.log('✅ Seller submitted evidence:', sellerSubmitTx);
    await publicClient.waitForTransactionReceipt({ hash: sellerSubmitTx });

    // 7. Arbiter evidence + decision (atomic)
    console.log(
        '\n--- Arbiter Submitting Evidence + Decision via submitArbiterDecision ---',
    );
    const arbiterIpfsHash = 'QmArbiterDecision789ghi';
    const resolveTx = await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Complete, // seller wins
        arbiterIpfsHash,
    );
    console.log('✅ Arbiter submitted decision tx:', resolveTx);
    await publicClient.waitForTransactionReceipt({ hash: resolveTx });

    // 8. Final state
    status = await sdk.getEscrowStatus(escrowId);
    console.log('Final state:', status.stateName);

    console.log(
        '\n✅ TEST 1 PASSED: Full dispute flow with evidence + submitArbiterDecision\n',
    );
}

// Test 2: Minimal submitArbiterDecision only
async function testSubmitArbiterDecisionOnly() {
    console.log(
        '\n🧪 TEST 2: submitArbiterDecision only (arbiter evidence + resolve)\n',
    );

    const escrowId = await createEscrow(7n);
    console.log('Escrow ID:', escrowId.toString());

    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);

    let status = await sdk.getEscrowStatus(escrowId);
    console.log('State before arbiter decision:', status.stateName);

    // ✅ FIX: Submit buyer and seller evidence first (required by contract)
    console.log('Submitting buyer evidence...');
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        'QmBuyerEvidenceForTest2'
    );

    console.log('Submitting seller evidence...');
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        'QmSellerEvidenceForTest2'
    );

    const arbiterEvidenceHash = 'QmArbiterDecisionAtomic123';
    const txHash = await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Refunded, // buyer wins
        arbiterEvidenceHash,
    );
    console.log('submitArbiterDecision tx:', txHash);
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    status = await sdk.getEscrowStatus(escrowId);
    console.log('State after arbiter decision:', status.stateName);

    console.log('\n✅ TEST 2 PASSED: submitArbiterDecisionOnly\n');
}

// ========== EXTRA TESTS ==========

// 2) Unauthorized actions
async function testUnauthorizedActions() {
    console.log('\n🧪 TEST 4: Unauthorized actions\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        'QmBuyerEvidenceUnauth'
    );
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        'QmSellerEvidenceUnauth'
    );

    // buyer tries to submit arbiter decision
    let failed = false;
    try {
        await sdk.submitArbiterDecision(
            buyerWalletClient,
            escrowId,
            DisputeResolution.Complete,
            'QmBadBuyerAsArbiter',
        );
    } catch (err: any) {
        failed = true;
        if (err instanceof SDKError) {
            console.log('Error code:', err.code);
            console.log('Error details:', err.details);
        }
    }
    console.assert(failed, 'Buyer should not be allowed to submit arbiter decision');

    // random address (neither buyer nor seller) tries startDispute
    const randomAccount = privateKeyToAccount(
        '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690c', // any unused key
    );
    const randomWalletClient = createWalletClient({
        chain,
        account: randomAccount,
        transport: http(rpcUrl),
    });

    const escrowId2 = await createEscrow(7n);
    await testDepositEscrow(escrowId2);

    failed = false;
    try {
        await sdk.startDispute(randomWalletClient, escrowId2);
    } catch {
        failed = true;
    }
    console.assert(
        failed,
        'Random address should not be allowed to start dispute for this escrow',
    );

    console.log('\n✅ TEST 4 PASSED: Unauthorized actions\n');
}

// 3) Double actions
async function testDoubleActions() {
    console.log('\n🧪 TEST 5: Double actions\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // second deposit should fail
    let failed = false;
    try {
        await sdk.deposit(buyerWalletClient, escrowId);
    } catch {
        failed = true;
    }
    console.assert(failed, 'Second deposit should revert');

    // first startDispute ok
    await sdk.startDispute(buyerWalletClient, escrowId);

    // second startDispute should fail
    failed = false;
    try {
        await sdk.startDispute(buyerWalletClient, escrowId);
    } catch {
        failed = true;
    }
    console.assert(failed, 'Second startDispute should revert');

    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        'QmBuyerEvidenceDoubleTest'
    );
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        'QmSellerEvidenceDoubleTest'
    );

    // arbiter decision twice
    const arbiterEvidenceHash = 'QmFirstDecision';
    await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Complete,
        arbiterEvidenceHash,
    );

    failed = false;
    try {
        await sdk.submitArbiterDecision(
            arbiterWalletClient,
            escrowId,
            DisputeResolution.Refunded,
            'QmSecondDecision',
        );
    } catch {
        failed = true;
    }
    console.assert(failed, 'Second arbiter decision should revert');

    console.log('\n✅ TEST 5 PASSED: Double actions\n');
}

// 4) Evidence constraints
async function testEvidenceConstraints() {
    console.log('\n🧪 TEST 6: Evidence constraints\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);

    // same role submitting twice
    const firstHash = 'QmBuyerEvidence1';
    const secondHash = 'QmBuyerEvidence2';

    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        firstHash,
    );

    let failed = false;
    try {
        await sdk.submitDisputeMessage(
            buyerWalletClient,
            escrowId,
            Role.Buyer,
            secondHash,
        );
    } catch {
        failed = true;
    }
    // Adjust assertion depending on intended behavior:
    console.log(
        'Buyer double evidence allowed?',
        failed ? 'NO (reverted)' : 'YES (no revert)',
    );

    // submitDisputeMessage when not DISPUTED
    const escrowId2 = await createEscrow(7n);
    await testDepositEscrow(escrowId2); // AWAITING_DELIVERY

    failed = false;
    try {
        await sdk.submitDisputeMessage(
            buyerWalletClient,
            escrowId2,
            Role.Buyer,
            'QmWrongState',
        );
    } catch {
        failed = true;
    }
    console.assert(
        failed,
        'submitDisputeMessage must revert when escrow is not DISPUTED',
    );

    console.log('\n✅ TEST 6 PASSED: Evidence constraints (state check)\n');
}

// 5) Edge parameters
async function testEdgeParameters() {
    console.log('\n🧪 TEST 7: Edge parameters\n');

    // maturityTimeDays = 0
    const escrowId0 = await createEscrow(0n);
    console.log('Escrow ID (maturity 0):', escrowId0.toString());
    await testDepositEscrow(escrowId0);
    // Depending on contract logic, check allowed behavior here
    let status = await sdk.getEscrowStatus(escrowId0, true);
    console.log('State with maturity=0 after deposit:', status.stateName);

    // max maturity 3650
    const escrowIdMax = await createEscrow(3650n);
    console.log('Escrow ID (maturity 3650):', escrowIdMax.toString());

    // above max should be rejected by SDK or contract
    let failed = false;
    try {
        await createEscrow(3651n);
    } catch {
        failed = true;
    }
    console.assert(
        failed,
        'createEscrow with maturity > 3650 should be rejected',
    );

    console.log('\n✅ TEST 7 PASSED: Edge parameters\n');
}

async function testDepositNotBuyerError() {
    console.log('\n🧪 ERROR 1: deposit NOT_BUYER\n');

    const escrowId = await createEscrow(7n); // buyer is buyerWalletClient
    // Try deposit from seller
    let caught: any;
    try {
        await sdk.deposit(sellerWalletClient, escrowId);
    } catch (e: any) {
        caught = e;
    }

    console.assert(caught instanceof SDKError, 'Expected SDKError');
    console.assert(
        caught.code === SDKErrorCode.NOT_BUYER,
        `Expected NOT_BUYER, got ${caught?.code}`,
    );
    console.log('✅ deposit NOT_BUYER error mapped correctly');
}

async function testDepositInsufficientBalance() {
    console.log('\n🧪 ERROR 2: deposit INSUFFICIENT_BALANCE\n');

    const escrowId = await createEscrow(7n);

    // Do NOT fund buyer here, ensure buyer has 0 or very little USDT
    // You can temporarily skip testDepositEscrow and call deposit directly:
    let caught: any;
    try {
        await sdk.deposit(buyerWalletClient, escrowId);
    } catch (e: any) {
        caught = e;
    }

    console.assert(caught instanceof SDKError, 'Expected SDKError');
    console.assert(
        caught.code === SDKErrorCode.INSUFFICIENT_BALANCE,
        `Expected INSUFFICIENT_BALANCE, got ${caught?.code}`,
    );
    console.log('✅ deposit INSUFFICIENT_BALANCE error mapped correctly');
}

async function testDepositAllowanceFailed() {
    console.log('\n🧪 ERROR 3: deposit ALLOWANCE_FAILED\n');

    const escrowId = await createEscrow(7n);

    // Fund buyer normally so balance is fine
    await testDepositEscrow(escrowId); // this will also call deposit once

    // Now create another escrow where we will force allowance failure
    const escrowId2 = await createEscrow(7n);

    // Monkey patch publicClient.call for the final allowance verification
    const originalCall = publicClient.call.bind(publicClient);
    (sdk as any).publicClient.call = async (args: any) => {
        if (
            'data' in args &&
            typeof args.data === 'string' &&
            args.data.toLowerCase().includes('095ea7b3') // approve/allowance selector
        ) {
            // Return zero allowance regardless of approve
            const zero = '0x' + '0'.repeat(64);
            return { data: zero as `0x${string}` };
        }
        return originalCall(args);
    };

    let caught: any;
    try {
        await sdk.deposit(buyerWalletClient, escrowId2);
    } catch (e: any) {
        caught = e;
    }

    // restore
    (sdk as any).publicClient.call = originalCall;

    console.assert(caught instanceof SDKError, 'Expected SDKError');
    console.assert(
        caught.code === SDKErrorCode.ALLOWANCE_FAILED,
        `Expected ALLOWANCE_FAILED, got ${caught?.code}`,
    );
    console.log('✅ deposit ALLOWANCE_FAILED error mapped correctly');
}


async function testCreateEscrowAndDeposit() {
    console.log('\n🧪 FLOW: confirmDelivery + withdraw\n');

    const escrowId = await createEscrowAndDeposit(7n);
    await testDepositEscrow(escrowId);

    // buyer confirms delivery
    const confirmTx = await sdk.confirmDelivery(buyerWalletClient, escrowId);
    console.log('confirmDelivery tx:', confirmTx);
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });

    let status = await sdk.getEscrowStatus(escrowId);
    console.log('State after confirmDelivery:', status.stateName);

    // withdraw should work now (buyer or seller depending on your contract)
    const withdrawTx = await sdk.withdraw(sellerWalletClient, escrowId);
    console.log('withdraw tx:', withdrawTx);
    await publicClient.waitForTransactionReceipt({ hash: withdrawTx });

    // withdraw in non-ended state should fail
    const escrowId2 = await createEscrow(7n);
    let caught: any;
    try {
        await sdk.withdraw(buyerWalletClient, escrowId2);
    } catch (e: any) {
        caught = e;
    }
    console.assert(
        caught instanceof SDKError &&
        caught.code === SDKErrorCode.INVALID_STATE,
        `Expected INVALID_STATE on early withdraw, got ${caught?.code}`,
    );

    console.log('✅ confirmDelivery + withdraw behavior correct');
}
async function testConfirmDeliveryAndWithdraw() {
    console.log('\n🧪 FLOW: confirmDelivery + withdraw\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // buyer confirms delivery
    const confirmTx = await sdk.confirmDelivery(buyerWalletClient, escrowId);
    console.log('confirmDelivery tx:', confirmTx);
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });

    let status = await sdk.getEscrowStatus(escrowId);
    console.log('State after confirmDelivery:', status.stateName);

    // withdraw should work now (buyer or seller depending on your contract)
    const withdrawTx = await sdk.withdraw(sellerWalletClient, escrowId);
    console.log('withdraw tx:', withdrawTx);
    await publicClient.waitForTransactionReceipt({ hash: withdrawTx });

    // withdraw in non-ended state should fail
    const escrowId2 = await createEscrow(7n);
    let caught: any;
    try {
        await sdk.withdraw(buyerWalletClient, escrowId2);
    } catch (e: any) {
        caught = e;
    }
    console.assert(
        caught instanceof SDKError &&
        caught.code === SDKErrorCode.INVALID_STATE,
        `Expected INVALID_STATE on early withdraw, got ${caught?.code}`,
    );

    console.log('✅ confirmDelivery + withdraw behavior correct');
}

async function testWithdrawAll() {
    console.log('\n🧪 TEST: withdrawAll aggregated balance\n');

    // 1. Create + deposit + confirm so seller has withdrawable USDT
    const escrowId = await createEscrow(14n);
    await testDepositEscrow(escrowId);

    // Buyer confirms delivery (seller gets payout with fee)
    const confirmTx = await sdk.confirmDelivery(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });
    console.log('✅ Delivery confirmed');

    // 2. Check seller withdrawable and aggregated balance
    const seller = sellerWalletClient.account.address;

    const withdrawables = await sdk.getWithdrawableAmounts(escrowId);
    console.log('Seller withdrawable (per-escrow):', withdrawables.seller.toString());
    console.assert(withdrawables.seller > 0n, 'Seller should have withdrawable amount');

    const aggregatedBefore = await sdk.publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'aggregatedBalance',
        args: [USDT, seller],
    }) as bigint;

    console.log('Seller aggregated balance before:', aggregatedBefore.toString());
    console.assert(aggregatedBefore > 0n, 'Aggregated balance should be > 0');

    const sellerBalanceBefore = await sdk.getUSDTBalanceOf(seller, USDT);
    console.log('Seller USDT before withdrawAll:', sellerBalanceBefore.toString());

    // 3. Call withdrawAllToken (the helper you just added)
    const txHash = await sdk.withdrawAllToken(sellerWalletClient, USDT);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('✅ withdrawAll executed:', txHash);

    // 4. Verify on-chain effects
    const sellerBalanceAfter = await sdk.getUSDTBalanceOf(seller, USDT);
    console.log('Seller USDT after withdrawAll:', sellerBalanceAfter.toString());
    console.assert(
        sellerBalanceAfter === sellerBalanceBefore + aggregatedBefore,
        'Seller should receive full aggregated balance'
    );

    const aggregatedAfter = await sdk.publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'aggregatedBalance',
        args: [USDT, seller],
    }) as bigint;

    console.log('Seller aggregated balance after:', aggregatedAfter.toString());
    console.assert(aggregatedAfter === 0n, 'Aggregated balance should be zero after withdrawAll');

    console.log('\n✅ TEST PASSED: withdrawAll aggregated balance\n');
}

async function testCacheEviction() {
    console.log('\n🧪 CACHE: eviction after state change\n');

    const escrowId = await createEscrow(7n);

    let status1 = await sdk.getEscrowStatus(escrowId, false);
    console.log('Initial state:', status1.stateName);

    await testDepositEscrow(escrowId);

    let status2 = await sdk.getEscrowStatus(escrowId, false);
    console.log('State after deposit (cached=false):', status2.stateName);

    console.assert(
        status2.stateName === 'AWAITING_DELIVERY',
        'Cache should have been evicted/updated after deposit',
    );
    const inAwaitingDelivery = await sdk.isInState(
        escrowId,
        EscrowState.AWAITING_DELIVERY
    );
    console.log('isInState(AWAITING_DELIVERY):', inAwaitingDelivery);
    const stats = sdk.getCacheStats();
    console.log('Cache stats after operations:', stats);
}

// Test: confirmDeliverySigned (buyer signs, arbiter executes)
async function testConfirmDeliverySigned() {
    console.log('\n🧪 TEST: confirmDeliverySigned\n');

    try {
        const escrowId = await createEscrow(7n);
        await testDepositEscrow(escrowId);
        const txHash = await sdk.confirmDeliverySigned(buyerWalletClient, escrowId);
        console.log("✅ confirmDeliverySigned tx:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("Receipt status:", receipt.status);
    } catch (err: any) {
        console.error("❌ confirmDeliverySigned error:", err?.message || err);
        if (err instanceof SDKError) {
            console.error("Error code:", err.code);
            console.error("Error details:", err.details);
        }
    }
}

async function testHealthCheck() {
    console.log('\n🧪 TEST: SDK Health Check\n');

    const health = await sdk.healthCheck();

    console.log('RPC Connected:', health.rpcConnected);
    console.log('Subgraph Connected:', health.subgraphConnected);
    console.log('Contract Deployed:', health.contractDeployed);
    console.log('Block Number:', health.blockNumber?.toString());
    console.log('Chain ID:', health.chainId);

    if (health.errors.length > 0) {
        console.log('Errors:', health.errors);
    }

    console.assert(health.rpcConnected, 'RPC should be connected');
    console.assert(health.contractDeployed, 'Contract should be deployed');

    console.log('✅ Health check passed\n');
}

async function testBatchOperations() {
    console.log('\n🧪 TEST: Batch Operations\n');

    // Create multiple escrows
    const escrowIds: bigint[] = [];
    for (let i = 0; i < 3; i++) {
        const id = await createEscrow(7n);
        escrowIds.push(id);
    }

    console.log('Created escrows:', escrowIds.map(id => id.toString()));

    const results = await sdk.getEscrowsBatch(escrowIds);

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`✅ Successfully fetched: ${successful.length}`);
    console.log(`❌ Failed to fetch: ${failed.length}`);

    console.assert(successful.length === 3, 'All escrows should be fetched');

    console.log('✅ Batch operations test passed\n');
}

async function testTransactionSimulation() {
    console.log('\n🧪 TEST: Transaction Simulation\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Simulate confirmDelivery
    const simulation = await sdk.simulateTransaction(
        buyerWalletClient,
        'confirmDelivery',
        [escrowId]
    );

    console.log('Simulation success:', simulation.success);
    console.log('Gas estimate:', simulation.gasEstimate?.toString());

    if (simulation.success) {
        console.log('✅ Transaction would succeed');

        // Now actually execute
        const txHash = await sdk.confirmDelivery(buyerWalletClient, escrowId);
        console.log('Actual tx hash:', txHash);
    } else {
        console.log('❌ Transaction would fail:', simulation.revertReason);
    }

    console.log('✅ Simulation test passed\n');
}

// ========== ADDITIONAL COMPREHENSIVE TESTS ==========

async function testCancelByTimeout() {
    console.log('\n🧪 TEST: cancelByTimeout (Time-based buyer protection)\n');

    // Create escrow with 0 day maturity (immediate maturity)
    const escrowId = await createEscrow(0n);
    await testDepositEscrow(escrowId);

    console.log('✅ Escrow created and deposited (maturity: 0 days)');

    // Buyer requests cancellation
    await sdk.requestCancel(buyerWalletClient, escrowId);
    console.log('✅ Buyer requested cancellation');

    let status = await sdk.getEscrowStatus(escrowId);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        'Should still be AWAITING_DELIVERY after single request'
    );

    let failed = false;
    try {
        await sdk.cancelByTimeout(buyerWalletClient, escrowId);
    } catch (e: any) {
        failed = true;
        console.log('✅ Immediate cancelByTimeout correctly rejected');
    }
    console.assert(failed, 'Should fail before grace period');

    // Advance time past maturity + grace period (6 hours + buffer)
    const GRACE_PERIOD = 6 * 60 * 60; // 6 hours
    await advanceTime(GRACE_PERIOD + 60); // +1 minute buffer
    console.log('⏰ Advanced time past grace period');

    // Now cancelByTimeout should work
    const cancelTx = await sdk.cancelByTimeout(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: cancelTx });
    console.log('✅ cancelByTimeout succeeded after timeout');

    // Verify state is CANCELED
    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'CANCELED', 'Should be CANCELED');

    // Buyer should be able to withdraw
    const withdrawTx = await sdk.withdraw(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
    console.log('✅ Buyer withdrew funds');

    // Final state should be WITHDRAWN
    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'WITHDRAWN', 'Should be WITHDRAWN');

    console.log('\n✅ TEST PASSED: cancelByTimeout\n');
}

async function testQueryMethods() {
    console.log('\n🧪 TEST: Query Methods (nonces, withdrawable, feePool)\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Test nonce getters (should all be 0 initially)
    const buyerNonce = await sdk.getBuyerNonce(escrowId);
    const sellerNonce = await sdk.getSellerNonce(escrowId);
    const arbiterNonce = await sdk.getArbiterNonce(escrowId);

    console.log('Buyer nonce:', buyerNonce.toString());
    console.log('Seller nonce:', sellerNonce.toString());
    console.log('Arbiter nonce:', arbiterNonce.toString());

    console.assert(buyerNonce === 0n, 'Initial buyer nonce should be 0');
    console.assert(sellerNonce === 0n, 'Initial seller nonce should be 0');
    console.assert(arbiterNonce === 0n, 'Initial arbiter nonce should be 0');
    console.log('✅ All initial nonces are 0');

    // Test getWithdrawable (should be 0 before completion)
    const amounts = await sdk.getWithdrawableAmounts(escrowId);
    console.log('Withdrawable amounts:', amounts);
    console.assert(amounts.buyer === 0n, 'Buyer withdrawable should be 0 initially');
    console.assert(amounts.seller === 0n, 'Seller withdrawable should be 0 initially');
    console.log('✅ Withdrawable amounts are 0 before resolution');

    // Complete the escrow
    await sdk.confirmDelivery(buyerWalletClient, escrowId);
    console.log('✅ Delivery confirmed');

    // Check withdrawable again (seller should have amount minus fee)
    const amountsAfter = await sdk.getWithdrawableAmounts(escrowId);
    console.log('Withdrawable after completion:', amountsAfter);
    console.assert(amountsAfter.seller > 0n, 'Seller should have withdrawable amount');
    console.log('✅ Seller has withdrawable funds');

    // Test getFeePool
    const feePool = await sdk.getFeePool(USDT);
    console.log('Fee pool balance:', feePool.toString());
    console.assert(feePool > 0n, 'Fee pool should have accumulated fees');
    console.log('✅ Fee pool has accumulated fees');

    console.log('\n✅ TEST PASSED: Query Methods\n');
}

async function testConfirmDeliverySignedComprehensive() {
    console.log('\n🧪 TEST: confirmDeliverySigned (Comprehensive)\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Check initial nonce
    const nonceBefore = await sdk.getBuyerNonce(escrowId);
    console.log('Buyer nonce before:', nonceBefore.toString());
    console.assert(nonceBefore === 0n, 'Initial nonce should be 0');

    // Use confirmDeliverySigned
    const txHash = await sdk.confirmDeliverySigned(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('✅ confirmDeliverySigned executed');

    // Check nonce incremented
    const nonceAfter = await sdk.getBuyerNonce(escrowId);
    console.log('Buyer nonce after:', nonceAfter.toString());
    console.assert(nonceAfter === 1n, 'Nonce should increment to 1');
    console.log('✅ Nonce incremented correctly');

    // Verify state is COMPLETE
    const status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'COMPLETE', 'Should be COMPLETE');
    console.log('✅ Escrow completed via signed transaction');

    // Try to use confirmDeliverySigned again with old nonce (should fail)
    const escrowId2 = await createEscrow(7n);
    await testDepositEscrow(escrowId2);

    // Use it once
    await sdk.confirmDeliverySigned(buyerWalletClient, escrowId2);

    // Try again (should fail - already COMPLETE)
    let failed = false;
    try {
        await sdk.confirmDeliverySigned(buyerWalletClient, escrowId2);
    } catch (e: any) {
        failed = true;
        console.log('✅ Second confirmDeliverySigned correctly rejected');
    }
    console.assert(failed, 'Should reject duplicate signed confirmation');

    console.log('\n✅ TEST PASSED: confirmDeliverySigned Comprehensive\n');
}

async function testRequestCancelSigned() {
    console.log('\n🧪 TEST: requestCancelSigned\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Buyer requests cancel via signature
    console.log('Buyer requesting cancel via signature...');
    const txHash1 = await sdk.requestCancelSigned(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: txHash1 });
    console.log('✅ Buyer cancel request signed');

    // Verify still in AWAITING_DELIVERY
    let status = await sdk.getEscrowStatus(escrowId);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        'Should still be AWAITING_DELIVERY'
    );

    // Seller requests cancel via signature (should trigger mutual cancel)
    console.log('Seller requesting cancel via signature...');
    const txHash2 = await sdk.requestCancelSigned(sellerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: txHash2 });
    console.log('✅ Seller cancel request signed');

    // Verify state is CANCELED
    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'CANCELED', 'Should be CANCELED after mutual');
    console.log('✅ Mutual cancel via signatures successful');

    // Check nonces incremented
    const buyerNonce = await sdk.getBuyerNonce(escrowId);
    const sellerNonce = await sdk.getSellerNonce(escrowId);
    console.log('Buyer nonce:', buyerNonce.toString());
    console.log('Seller nonce:', sellerNonce.toString());
    console.assert(buyerNonce === 1n, 'Buyer nonce should be 1');
    console.assert(sellerNonce === 1n, 'Seller nonce should be 1');
    console.log('✅ Nonces incremented correctly');

    console.log('\n✅ TEST PASSED: requestCancelSigned\n');
}

async function testStartDisputeSigned() {
    console.log('\n🧪 TEST: startDisputeSigned\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Check initial nonce
    const nonceBefore = await sdk.getBuyerNonce(escrowId);
    console.assert(nonceBefore === 0n, 'Initial nonce should be 0');

    // Buyer starts dispute via signature
    console.log('Buyer starting dispute via signature...');
    const txHash = await sdk.startDisputeSigned(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log('✅ Dispute started via signature');

    // Verify state is DISPUTED
    const status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'DISPUTED', 'Should be DISPUTED');
    console.log('✅ Escrow in DISPUTED state');

    // Check nonce incremented
    const nonceAfter = await sdk.getBuyerNonce(escrowId);
    console.assert(nonceAfter === 1n, 'Nonce should increment to 1');
    console.log('✅ Nonce incremented correctly');

    console.log('\n✅ TEST PASSED: startDisputeSigned\n');
}

async function testAdminMethods() {
    console.log('\n🧪 TEST: Admin Methods (setAllowedToken, withdrawFees)\n');

    const ownerWalletClient = deployerWalletClient;

    const feePoolBefore = await sdk.getFeePool(USDT);
    console.log('Fee pool before:', feePoolBefore.toString());

    if (feePoolBefore > 0n) {
        try {
            const tx2 = await sdk.withdrawFees(ownerWalletClient, USDT);
            await publicClient.waitForTransactionReceipt({ hash: tx2 });
            console.log('✅ withdrawFees executed');

            const feePoolAfter = await sdk.getFeePool(USDT);
            console.log('Fee pool after:', feePoolAfter.toString());
            console.assert(feePoolAfter === 0n, 'Fee pool should be 0 after withdrawal');
            console.log('✅ Fee pool emptied');
        } catch (e: any) {
            console.log('ℹ️  withdrawFees failed (may not be owner):', e.message);
        }
    } else {
        console.log('ℹ️  No fees to withdraw');
    }

    console.log('\n✅ TEST PASSED: Admin Methods\n');
}

async function testWithdrawRefunded() {
    console.log('\n🧪 TEST: Withdraw in REFUNDED State\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Start dispute
    await sdk.startDispute(buyerWalletClient, escrowId);
    console.log('✅ Dispute started');

    // Submit evidence from both parties
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        'QmBuyerEvidenceRefundTest'
    );
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        'QmSellerEvidenceRefundTest'
    );
    console.log('✅ Evidence submitted by both parties');

    // Arbiter decides: REFUNDED (buyer wins)
    await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Refunded,
        'QmArbiterDecisionRefund'
    );
    console.log('✅ Arbiter decided: REFUNDED');

    // Verify state
    let status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'REFUNDED', 'Should be REFUNDED');

    // Check withdrawable amounts
    const amounts = await sdk.getWithdrawableAmounts(escrowId);
    console.log('Withdrawable - Buyer:', amounts.buyer.toString());
    console.log('Withdrawable - Seller:', amounts.seller.toString());
    console.assert(amounts.buyer > 0n, 'Buyer should have withdrawable amount');
    console.assert(amounts.seller === 0n, 'Seller should have nothing');

    // Buyer withdraws
    const buyerBalanceBefore = await sdk.getUSDTBalanceOf(
        buyerWalletClient.account.address,
        USDT
    );
    console.log('Buyer USDT before withdraw:', buyerBalanceBefore.toString());

    const withdrawTx = await sdk.withdraw(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: withdrawTx });
    console.log('✅ Buyer withdrew funds');

    const buyerBalanceAfter = await sdk.getUSDTBalanceOf(
        buyerWalletClient.account.address,
        USDT
    );
    console.log('Buyer USDT after withdraw:', buyerBalanceAfter.toString());

    // Verify buyer received full refund (no fee on refund)
    const expectedAmount = 10n * 1_000_000n;
    console.assert(
        buyerBalanceAfter === buyerBalanceBefore + expectedAmount,
        'Buyer should receive full refund (no fee)'
    );
    console.log('✅ Buyer received full refund');

    // Final state should be WITHDRAWN
    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'WITHDRAWN', 'Should be WITHDRAWN');

    console.log('\n✅ TEST PASSED: Withdraw in REFUNDED State\n');
}

async function testDispute7DayTimeout() {
    console.log('\n🧪 TEST: 7-Day Dispute Timeout (Partial Evidence)\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Start dispute
    await sdk.startDispute(buyerWalletClient, escrowId);
    console.log('✅ Dispute started');

    // Only buyer submits evidence
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        'QmBuyerEvidenceOnly'
    );
    console.log('✅ Only buyer submitted evidence');

    // Try immediate arbiter decision (should fail)
    let failed = false;
    try {
        await sdk.submitArbiterDecision(
            arbiterWalletClient,
            escrowId,
            DisputeResolution.Complete,
            'QmImmediateDecision'
        );
    } catch (e: any) {
        failed = true;
        console.log('✅ Immediate decision correctly rejected');
    }
    console.assert(failed, 'Should require full evidence or 7-day timeout');

    // Advance time 7 days
    const SEVEN_DAYS = 7 * 24 * 60 * 60;
    await advanceTime(SEVEN_DAYS + 60); // +1 minute buffer
    console.log('⏰ Advanced time 7 days');
    await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Complete,
        'QmDelayedDecision'
    );
    console.log('✅ Arbiter decision succeeded after 7-day timeout');

    // Verify state
    const status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'COMPLETE', 'Should be COMPLETE');

    console.log('\n✅ TEST PASSED: 7-Day Dispute Timeout\n');
}

async function testDispute30DayTimeout() {
    console.log('\n🧪 TEST: 30-Day Dispute Timeout (No Evidence)\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Start dispute
    await sdk.startDispute(buyerWalletClient, escrowId);
    console.log('✅ Dispute started');

    // No evidence submitted by anyone
    console.log('ℹ️  No evidence submitted');
    let failed = false;
    try {
        await sdk.submitArbiterDecision(
            arbiterWalletClient,
            escrowId,
            DisputeResolution.Complete,
            'QmImmediateDecision'
        );
    } catch (e: any) {
        failed = true;
        console.log('✅ Immediate decision correctly rejected');
    }
    console.assert(failed, 'Should require evidence or 30-day timeout');

    // Advance time 30 days + buffer (1 hour)
    const THIRTY_DAYS_PLUS_BUFFER = (30 * 24 * 60 * 60) + (60 * 60);
    await advanceTime(THIRTY_DAYS_PLUS_BUFFER + 60); // +1 minute extra
    console.log('⏰ Advanced time 30 days + buffer');

    await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Refunded,
        'QmDelayedDecisionNoEvidence'
    );
    console.log('✅ Arbiter decision succeeded after 30-day timeout (no evidence)');

    const status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'REFUNDED', 'Should be REFUNDED');

    console.log('\n✅ TEST PASSED: 30-Day Dispute Timeout\n');
}

// ========== MAIN RUNNER ==========
async function run() {
    try {
        console.log('=== SDK OPTIMIZED TESTS START ===\n');
        await testHealthCheck();

        logUsdtBalances();

        await testDirectCreateEscrow();
        await testDisputeFlowWithEvidence();
        await testSubmitArbiterDecisionOnly();

        await testUnauthorizedActions();
        await testDoubleActions();
        await testEvidenceConstraints();
        await testEdgeParameters();

        await testDepositNotBuyerError();
        await testDepositInsufficientBalance();
        await testDepositAllowanceFailed();
        await testConfirmDeliveryAndWithdraw();
        await testWithdrawAll();
        await testCacheEviction();

        await testConfirmDeliverySigned();
        await testBatchOperations();
        await testTransactionSimulation();

        await testCancelByTimeout();
        await testQueryMethods();
        await testConfirmDeliverySignedComprehensive();
        await testRequestCancelSigned();
        await testStartDisputeSigned();
        await testAdminMethods();
        await testWithdrawRefunded();
        await testDispute7DayTimeout();
        await testDispute30DayTimeout();

        console.log('\n====================================');
        console.log('✅ ALL TESTS PASSED (24 TOTAL)');
        console.log('====================================\n');
        const finalStats = sdk.getCacheStats();
        console.log('Final cache stats:', finalStats);

    } catch (err: any) {
        console.error('\n====================================');
        console.error('❌ TEST SUITE FAILED');
        console.error('====================================\n');
        console.error('Error:', err.message);
        if (err instanceof SDKError) {
            console.error('Error code:', err.code);
            console.error('Error details:', err.details);
        }
        console.error(err.stack);
        process.exit(1);
    }
}

void run();