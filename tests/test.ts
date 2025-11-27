/**
 * PalindromeEscrowSDK integration test suite
 *
 * - Happy paths:
 *   - Direct viem-level createEscrow sanity check.
 *   - SDK createEscrow + deposit + startDispute + evidence + submitArbiterDecision
 *     for both COMPLETE (seller wins) and REFUNDED (buyer wins).
 *   - Maturity / auto-release flow (no dispute) via sdk.autoRelease.
 *   - Buyer confirmDelivery + correct withdraw caller in COMPLETE state.
 *
 * - Permissions & invalid flows:
 *   - Unauthorized submitArbiterDecision from buyer.
 *   - Unauthorized startDispute from a random address.
 *   - Double deposit, double startDispute, and double arbiter decision all revert.
 *   - Evidence submission when escrow is not DISPUTED, and same-role double evidence behavior.
 *
 * - SDK error mapping:
 *   - deposit by non-buyer -> SDKErrorCode.NOT_BUYER.
 *   - deposit with insufficient buyer USDT -> SDKErrorCode.INSUFFICIENT_BALANCE.
 *   - Broken allowance verification -> SDKErrorCode.ALLOWANCE_FAILED.
 *   - Early withdraw before escrow end -> SDKErrorCode.INVALID_STATE.
 *
 * - Edge conditions & helpers:
 *   - maturityTimeDays = 0 and 3650 accepted; > 3650 rejected.
 *   - Cache eviction and status helpers via getEscrowStatus / isInState.
 *
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
    Role,
    DisputeResolution,
    SDKError,
    SDKErrorCode,
    EscrowData
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
    contractAddress,
    publicClient,
    buyerWalletClient,
    sellerWalletClient,
    apollo,
    chain,
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

    // Fund buyer with USDT from DEPLOYER (USDT minter) if needed
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

// 1) Maturity / auto-release path
async function testMaturityAutoRelease() {
    console.log('\n🧪 TEST 3: Maturity auto-release (no dispute)\n');

    // escrow with short maturity, e.g. 1 day
    const escrowId = await createEscrow(1n);
    console.log('Escrow ID:', escrowId.toString());

    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.log('State after deposit:', status.stateName);

    const twoDays = 2 * 24 * 60 * 60;

    // cast to any to bypass TS method union
    await (publicClient as any).request({
        method: 'evm_increaseTime',
        params: [twoDays],
    });

    await (publicClient as any).request({
        method: 'evm_mine',
        params: [],
    });


    // whatever function you have to release after maturity
    // replace `release` with your actual function name if different
    const releaseTx = await sdk.autoRelease(sellerWalletClient, escrowId);
    console.log('Release tx:', releaseTx);
    await publicClient.waitForTransactionReceipt({ hash: releaseTx });

    status = await sdk.getEscrowStatus(escrowId);
    console.log('State after release:', status.stateName);
    console.assert(
        status.stateName === 'COMPLETE',
        'Should be COMPLETE after auto-release',
    );

    // startDispute should now revert
    let failed = false;
    try {
        await sdk.startDispute(buyerWalletClient, escrowId);
    } catch {
        failed = true;
    }
    console.assert(failed, 'startDispute should fail after completion');

    console.log('\n✅ TEST 3 PASSED: Maturity auto-release\n');
}

// 2) Unauthorized actions
async function testUnauthorizedActions() {
    console.log('\n🧪 TEST 4: Unauthorized actions\n');

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);

    // buyer tries to submit arbiter decision
    let failed = false;
    try {
        await sdk.submitArbiterDecision(
            buyerWalletClient,
            escrowId,
            DisputeResolution.Complete,
            'QmBadBuyerAsArbiter',
        );
    } catch {
        failed = true;
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


// Test: deposit called by non-buyer should throw NOT_BUYER
async function testDepositNotBuyerError() {
    console.log('\n🧪 ERROR 1: deposit NOT_BUYER\n');

    const escrowId = await createEscrow(7n); // buyer is buyerWalletClient
    // Try deposit from seller
    let caught: any;
    try {
        await sdk.deposit(sellerWalletClient, escrowId);
    } catch (e) {
        caught = e;
    }

    console.assert(caught instanceof SDKError, 'Expected SDKError');
    console.assert(
        caught.code === SDKErrorCode.NOT_BUYER,
        `Expected NOT_BUYER, got ${caught?.code}`,
    );
    console.log('✅ deposit NOT_BUYER error mapped correctly');
}

// Test: deposit with insufficient balance should throw INSUFFICIENT_BALANCE
async function testDepositInsufficientBalance() {
    console.log('\n🧪 ERROR 2: deposit INSUFFICIENT_BALANCE\n');

    const escrowId = await createEscrow(7n);

    // Do NOT fund buyer here, ensure buyer has 0 or very little USDT
    // You can temporarily skip testDepositEscrow and call deposit directly:
    let caught: any;
    try {
        await sdk.deposit(buyerWalletClient, escrowId);
    } catch (e) {
        caught = e;
    }

    console.assert(caught instanceof SDKError, 'Expected SDKError');
    console.assert(
        caught.code === SDKErrorCode.INSUFFICIENT_BALANCE,
        `Expected INSUFFICIENT_BALANCE, got ${caught?.code}`,
    );
    console.log('✅ deposit INSUFFICIENT_BALANCE error mapped correctly');
}

// Test: allowance verification failure should throw ALLOWANCE_FAILED
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
    } catch (e) {
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

// Test: buyer-only confirmDelivery + withdraw in COMPLETE state
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
    } catch (e) {
        caught = e;
    }
    console.assert(
        caught instanceof SDKError &&
        caught.code === SDKErrorCode.INVALID_STATE,
        `Expected INVALID_STATE on early withdraw, got ${caught?.code}`,
    );

    console.log('✅ confirmDelivery + withdraw behavior correct');
}

// Test: cache eviction after state change
async function testCacheEviction() {
    console.log('\n🧪 CACHE: eviction after state change\n');

    const escrowId = await createEscrow(7n);

    let status1 = await sdk.getEscrowStatus(escrowId, false);
    console.log('Initial state:', status1.stateName);

    await testDepositEscrow(escrowId);

    // If cache not cleared, this would still show AWAITING_PAYMENT
    let status2 = await sdk.getEscrowStatus(escrowId, false);
    console.log('State after deposit (cached=false):', status2.stateName);

    console.assert(
        status2.stateName === 'AWAITING_DELIVERY',
        'Cache should have been evicted/updated after deposit',
    );

    const inAwaitingDelivery = await sdk.isInState(
        escrowId,
        SDKErrorCode.AWAITING_DELIVERY as any, // or EscrowState.AWAITING_DELIVERY
    );
    console.log('isInState(AWAITING_DELIVERY):', inAwaitingDelivery);
}

// Test: confirmDeliverySigned (buyer signs, arbiter executes)
async function testConfirmDeliverySigned() {
    try {
        const escrowId = await createEscrow(7n);
        await testDepositEscrow(escrowId);
        const txHash = await sdk.confirmDeliverySigned(buyerWalletClient, escrowId);
        console.log("confirmDeliverySigned tx:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("confirmDeliverySigned confirmed:", receipt);
    } catch (err: any) {
        console.error("confirmDeliverySigned error:", err?.message || err);
    }
}

// ========== MAIN RUNNER ==========

async function run() {
    try {
        logUsdtBalances();
        console.log('=== SDK DISPUTE TESTS START ===');

        await testDirectCreateEscrow();
        await testDisputeFlowWithEvidence();
        await testSubmitArbiterDecisionOnly();


        await testMaturityAutoRelease();
        await testUnauthorizedActions();
        await testDoubleActions();
        await testEvidenceConstraints();
        await testEdgeParameters();

        await testDepositNotBuyerError();
        await testDepositInsufficientBalance();
        await testDepositAllowanceFailed();
        await testConfirmDeliveryAndWithdraw();
        await testCacheEviction();

        await testConfirmDeliverySigned();

        console.log('\n====================================');
        console.log('✅ ALL TESTS PASSED');
        console.log('====================================\n');
    } catch (err: any) {
        console.error('\n====================================');
        console.error('❌ TEST SUITE FAILED');
        console.error('====================================\n');
        console.error('Error:', err.message);
        console.error(err.stack);
        process.exit(1);
    }
}

void run();
