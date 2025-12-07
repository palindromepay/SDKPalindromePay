/**
 * PalindromeEscrowSDK – Production Coverage Test Suite
 */

import "dotenv/config";
import {
    createPublicClient,
    createWalletClient,
    http,
    WalletClient,
    Address,
    Hex,
    parseEventLogs,
    PublicClient,
} from "viem";
import { hardhat } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client/core";

import {
    PalindromeEscrowSDK,
    CreateEscrowParams,
    CreateEscrowAndDepositParams,
    Role,
    DisputeResolution,
    SDKErrorCode,
    EscrowCreatedEvent
} from "../src/PalindromeEscrowSDK";

import {
    PalindromeEscrowWalletClient,
    signWalletHash,
} from "../src/PalindromeEscrowWalletClient";
import PalindromeEscrowWalletABI from "../src/contract/PalindromeEscrowWallet.json";
import assert from "assert";

// ────────────────────────────── ENV & CLIENTS ──────────────────────────────

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`;
const subgraphUrl =
    process.env.SUBGRAPH_URL ||
    "https://api.studio.thegraph.com/query/121986/palindrome-finance-subgraph/version/latest";
const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const sellerKey = process.env.SELLER_PRIVATE_KEY as `0x${string}`;
const arbiterKey = process.env.ARBITER_PRIVATE_KEY as `0x${string}`;
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const USDT = process.env.USDT as `0x${string}`;

if (!contractAddress) throw new Error("CONTRACT_ADDRESS env var is missing!");
if (!buyerKey) throw new Error("BUYER_PRIVATE_KEY env var is missing!");
if (!sellerKey) throw new Error("SELLER_PRIVATE_KEY env var is missing!");
if (!arbiterKey) throw new Error("ARBITER_PRIVATE_KEY env var is missing!");
if (!deployerKey) throw new Error("DEPLOYER_PRIVATE_KEY env var is missing!");
if (!USDT) throw new Error("USDT env var is missing!");

const chain = hardhat;

const buyerAccount = privateKeyToAccount(buyerKey);
const sellerAccount = privateKeyToAccount(sellerKey);
const arbiterAccount = privateKeyToAccount(arbiterKey);
const deployerAccount = privateKeyToAccount(deployerKey);

const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
}) as PublicClient & {
    request: (args: any) => Promise<any>;
};

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
    walletClient: buyerWalletClient,
    apolloClient: apollo,
    chain,
    cacheTTL: 5000,
    enableRetry: true,
    maxRetries: 3,
    gasBuffer: 20,
    defaultToken: USDT,
});

const ONE_USDT = 1_000_000n;

// ────────────────────────────── HELPERS ──────────────────────────────

async function fundBuyer(amount: bigint = 100n * ONE_USDT) {
    const buyer = buyerWalletClient.account.address;
    const bal = await sdk.getTokenBalanceOf(buyer, USDT);
    if (bal >= amount) return;
    await deployerWalletClient.writeContract({
        address: USDT,
        abi: sdk.abiERC20,
        functionName: "transfer",
        args: [buyer, amount - bal],
    });
    await mineBlock();
}

async function createEscrow(maturityDays = 14n): Promise<bigint> {
    await fundBuyer();
    const params: CreateEscrowParams = {
        token: USDT,
        buyer: buyerWalletClient.account.address,
        amount: 10n * ONE_USDT,
        maturityTimeDays: maturityDays,
        arbiter: arbiterAccount.address,
        title: "Coverage Test",
        ipfsHash: "QmCoverage...",
    };
    const { escrowId } = await sdk.createEscrow(sellerWalletClient, params);
    return escrowId!;
}

async function createEscrowAndDeposit(maturityDays = 14n): Promise<bigint> {
    await fundBuyer();
    const params: CreateEscrowAndDepositParams = {
        token: USDT,
        seller: sellerWalletClient.account.address,
        amount: 10n * ONE_USDT,
        maturityTimeDays: maturityDays,
        arbiter: arbiterAccount.address,
        title: "Coverage Test",
        ipfsHash: "QmCoverage...",
    };
    const { escrowId } = await sdk.createEscrowAndDeposit(
        buyerWalletClient,
        params
    );
    return escrowId!;
}

async function deposit(escrowId: bigint) {
    await fundBuyer();
    await sdk.deposit(buyerWalletClient, escrowId);
}

async function increaseTime(seconds: number) {
    await publicClient.request({
        method: "evm_increaseTime" as any,
        params: [seconds],
    });
    await mineBlock();
}

async function mineBlock() {
    await publicClient.request({
        method: "evm_mine" as any,
        params: [],
    });
}

// ────────────────────────────── CORE TESTS ──────────────────────────────

async function testHealthCheck() {
    console.log("\nTEST: SDK Health Check\n");
    const health = await sdk.healthCheck();
    console.log("RPC Connected:", health.rpcConnected);
    console.log("Subgraph Connected:", health.subgraphConnected);
    console.log("Contract Deployed:", health.contractDeployed);
    console.assert(health.rpcConnected, "RPC should be connected");
    console.assert(health.contractDeployed, "Contract should be deployed");
    console.log("✅ TEST passed: SDK Health Check\n");
}

async function testDirectCreateEscrow() {
    console.log("\nTEST: DIRECT createEscrow sanity check\n");

    const amount = 10n * ONE_USDT;
    const buyer = buyerWalletClient.account.address;
    const seller = sellerWalletClient.account.address;
    const arbiter = arbiterWalletClient.account.address;

    const txHash = await sellerWalletClient.writeContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: "createEscrow",
        args: [
            USDT,
            buyer,
            amount,
            14n,
            arbiter,
            "Direct Test Title",
            "QmDirectTest...",
        ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.assert(receipt.status === "success", "Direct createEscrow tx failed");

    const events = parseEventLogs({
        abi: sdk.abiEscrow,
        logs: receipt.logs,
        eventName: "EscrowCreated",
    }) as Array<{ args: { escrowId: bigint } }>;

    console.assert(events.length > 0, "EscrowCreated event emitted");
    console.log("Direct escrowId:", events[0].args.escrowId.toString());
    console.log("✅ TEST passed: DIRECT createEscrow sanity check\n");
}

async function testDepositEscrow(escrowId: bigint) {
    console.log("\nTEST: Deposit Escrow\n");
    const amount = 10n * ONE_USDT;
    const buyer = buyerWalletClient.account.address;

    let buyerBalance = await sdk.getTokenBalanceOf(buyer, USDT);
    if (buyerBalance < amount) {
        console.log(
            `Funding buyer with ${amount - buyerBalance} wei USDT from deployer...`
        );
        await deployerWalletClient.writeContract({
            address: USDT,
            abi: sdk.abiERC20,
            functionName: "transfer",
            args: [buyer, amount - buyerBalance],
        });
        await mineBlock();
    }

    console.log(`Depositing ${amount} USDT into escrow #${escrowId}`);
    const txHash = await sdk.deposit(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(`Deposit confirmed: ${txHash}`);

    const status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        `After deposit should be AWAITING_DELIVERY, got ${status.stateName}`
    );
    console.log("✅ TEST passed: Deposit Escrow\n");
}

async function testConfirmDeliverySigned() {
    console.log("\nTEST: confirmDeliverySigned (EIP-712 meta-tx)\n");

    // 1. Create escrow and deposit so state is AWAITING_DELIVERY
    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        `Expected AWAITING_DELIVERY, got ${status.stateName}`
    );

    // 2. Compute buyer nonce from bitmap
    const buyer = buyerWalletClient.account.address as Address;
    const nonce = await sdk.getUserNonce(escrowId, buyer);

    // 3. Deadline
    const deadline = await sdk.createSignatureDeadline(60);

    // 4. Build EIP-712 message using SDK internals
    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        nonce,
    );

    // 5. Sign typed data
    const signature = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: "ConfirmDelivery",
        message: msg,
    });

    // 6. Call 5-arg helper
    const txHash = await sdk.confirmDeliverySigned(
        buyerWalletClient,
        escrowId,
        signature as Hex,
        deadline,
        nonce,
    );
    await publicClient.waitForTransactionReceipt({ hash: txHash });

    // 7. Verify state COMPLETE
    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "COMPLETE",
        `Expected COMPLETE, got ${status.stateName}`,
    );

    console.log("✅ TEST passed: confirmDeliverySigned\n");
}

async function testHappyPathFullFlow() {
    console.log("\nHAPPY PATH: Full Flow (create → deposit → confirm → payout)\n");

    const escrowId = await createEscrow(7n);
    console.log(`Escrow #${escrowId} created`);

    await testDepositEscrow(escrowId);
    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        "After deposit: AWAITING_DELIVERY"
    );

    console.log("Buyer confirming delivery via signed meta-tx...");

    // EIP-712 nonce
    const nonce = await sdk.getUserNonce(
        escrowId,
        buyerWalletClient.account.address as Address
    );
    const deadline = await sdk.createSignatureDeadline(60);
    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        nonce
    );
    const signature = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: "ConfirmDelivery",
        message: msg,
    });

    const confirmTx = await sdk.confirmDeliverySigned(
        buyerWalletClient,
        escrowId,
        signature as Hex,
        deadline,
        nonce
    );
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });
    console.log(`Confirmed: ${confirmTx}`);

    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === "COMPLETE", "After confirm: COMPLETE");

    // Wallet nonce has a different name
    const { wallet, nonce: walletNonce } = await sdk.getEscrowWalletAndNonce(
        escrowId
    );
    console.log(`Wallet: ${wallet}, nonce: ${walletNonce}`);

    const total = 10n * ONE_USDT;
    const netAmount = 9_900_000n;
    const feeAmount = total - netAmount;
    const seller = sellerWalletClient.account.address;
    const feeTo = arbiterWalletClient.account.address;

    const sellerBefore = await sdk.getTokenBalanceOf(seller, USDT);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, USDT);
    const walletBefore = await sdk.getTokenBalanceOf(wallet, USDT);

    const walletClient = new PalindromeEscrowWalletClient(publicClient, chain.id);
    const txHashWallet = walletClient.buildSplitHash(
        wallet,
        USDT,
        seller,
        netAmount,
        feeTo,
        feeAmount,
        walletNonce
    );
    const buyerSig = await signWalletHash(buyerWalletClient, txHashWallet);
    const sellerSig = await signWalletHash(sellerWalletClient, txHashWallet);
    const signatures: [Hex, Hex, Hex] = [buyerSig, sellerSig, "0x"];

    console.log("Executing 2-of-3 payout...");
    const execTx = await sdk.executeEscrowERC20Split(
        buyerWalletClient,
        walletClient,
        escrowId,
        USDT,
        seller,
        netAmount,
        feeTo,
        feeAmount,
        signatures
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });
    console.log(`Payout executed: ${execTx}`);

    const sellerAfter = await sdk.getTokenBalanceOf(seller, USDT);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, USDT);
    const walletAfter = await sdk.getTokenBalanceOf(wallet, USDT);

    console.log(walletBefore, walletAfter);
    console.log(sellerBefore, sellerAfter);
    console.log(feeBefore, feeAfter);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${netAmount}`
    );
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee recipient received ${feeAmount}`
    );
    console.assert(walletAfter === 0n, "Wallet drained");

    const receipt = await publicClient.getTransactionReceipt({ hash: execTx });
    const payoutLogs = parseEventLogs({
        abi: PalindromeEscrowWalletABI.abi,
        logs: receipt.logs,
        eventName: "SplitExecuted",
    });
    console.assert(payoutLogs.length > 0, "SplitExecuted event emitted");

    const { nonce: nonceAfter } = await sdk.getEscrowWalletAndNonce(escrowId);
    console.assert(
        nonceAfter === nonce + 1n,
        "Wallet nonce incremented"
    );

    console.log("\nHAPPY PATH TEST PASSED: Full flow completed\n");
}

async function testExecuteEscrowERC20Split() {
    console.log(
        "\nTEST: executeEscrowERC20Split (2-of-3 multisig wallet)\n"
    );

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        "Must be AWAITING_DELIVERY"
    );

    const { wallet, nonce } = await sdk.getEscrowWalletAndNonce(escrowId);
    console.log("Wallet:", wallet, "nonce:", nonce.toString());

    const total = 10n * ONE_USDT;
    const netAmount = 9_900_000n;
    const feeAmount = total - netAmount;
    const seller = sellerWalletClient.account.address;
    const feeTo = arbiterWalletClient.account.address;

    const sellerBefore = await sdk.getTokenBalanceOf(seller, USDT);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, USDT);

    const walletClient = new PalindromeEscrowWalletClient(
        publicClient,
        chain.id
    );
    const txHashWallet = walletClient.buildSplitHash(
        wallet,
        USDT,
        seller,
        netAmount,
        feeTo,
        feeAmount,
        nonce
    );

    const buyerSig = await signWalletHash(buyerWalletClient, txHashWallet);
    const sellerSig = await signWalletHash(sellerWalletClient, txHashWallet);
    const signatures: [Hex, Hex, Hex] = [buyerSig, sellerSig, "0x"];

    const execTx = await sdk.executeEscrowERC20Split(
        buyerWalletClient,
        walletClient,
        escrowId,
        USDT,
        seller,
        netAmount,
        feeTo,
        feeAmount,
        signatures
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    const sellerAfter = await sdk.getTokenBalanceOf(seller, USDT);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, USDT);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        "Seller received net"
    );
    console.assert(
        feeAfter - feeBefore === feeAmount,
        "Fee recipient received fee"
    );

    console.log("\nTEST PASSED: executeEscrowERC20Split\n");
}

async function testConfirmDeliverySignedWrongSigner() {
    console.log("\nTEST: confirmDeliverySigned – wrong signer\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    const seller = sellerWalletClient.account.address as Address;
    const nonce = await sdk.getUserNonce(escrowId, seller); // seller nonce
    const deadline = await sdk.createSignatureDeadline(60);

    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        nonce,
    );

    const signature = await sellerWalletClient.signTypedData({
        account: sellerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: "ConfirmDelivery",
        message: msg,
    });

    let err: any;
    try {
        await sdk.confirmDeliverySigned(
            sellerWalletClient,
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        (err?.details?.originalError?.shortMessage ?? "").includes("Unauthorized signer") ||
        (err?.message ?? "").includes("Unauthorized signer"),
        "Should revert with Unauthorized signer",
    );

    console.log("✅ TEST passed: confirmDeliverySigned – wrong signer\n");
}


async function testConfirmDeliverySignedExpiredDeadline() {
    console.log("\nTEST: confirmDeliverySigned – expired deadline\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    const buyer = buyerWalletClient.account.address as Address;
    const nonce = await sdk.getUserNonce(escrowId, buyer);

    // Past deadline
    const deadline = BigInt(Math.floor(Date.now() / 1000) - 60);

    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        nonce,
    );

    const signature = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: "ConfirmDelivery",
        message: msg,
    });

    let err: any;
    try {
        await sdk.confirmDeliverySigned(
            buyerWalletClient,
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        err?.code === SDKErrorCode.SIGNATURE_EXPIRED ||
        (err?.details?.originalError?.shortMessage ?? "").includes("Invalid deadline"),
        "Should detect expired deadline",
    );

    console.log("✅ TEST passed: confirmDeliverySigned – expired deadline\n");
}

async function testConfirmDeliverySignedNonceReplay() {
    console.log("\nTEST: confirmDeliverySigned – nonce replay\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    const buyer = buyerWalletClient.account.address as Address;
    const nonce = await sdk.getUserNonce(escrowId, buyer);
    const deadline = await sdk.createSignatureDeadline(60);

    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        nonce,
    );

    const signature = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: "ConfirmDelivery",
        message: msg,
    });

    // First call: should succeed
    const tx1 = await sdk.confirmDeliverySigned(
        buyerWalletClient,
        escrowId,
        signature as Hex,
        deadline,
        nonce,
    );
    await publicClient.waitForTransactionReceipt({ hash: tx1 });

    // Second call with same (escrowId, signature, nonce) should revert
    let err: any;
    try {
        await sdk.confirmDeliverySigned(
            buyerWalletClient,
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        (err?.details?.originalError?.shortMessage ?? "").includes("Internal error") ||
        (err?.message ?? "").includes("Internal error"),
        "Should revert on nonce/signature replay",
    );

    console.log("✅ TEST passed: confirmDeliverySigned – nonce replay\n");
}

async function testRequestCancelMutual() {
    console.log("\nTEST: requestCancel – mutual on‑chain\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(status.stateName === "AWAITING_DELIVERY", "Must be AWAITING_DELIVERY");

    // Buyer requests cancel
    await sdk.requestCancel(buyerWalletClient, escrowId);

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        "After single request, still AWAITING_DELIVERY",
    );

    // Seller requests cancel
    await sdk.requestCancel(sellerWalletClient, escrowId);

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(status.stateName === "CANCELED", "After mutual request, state is CANCELED");

    console.log("✅ TEST passed: requestCancel – mutual on‑chain\n");
}

async function testRequestCancelSigned() {
    console.log("\nTEST: requestCancelSigned – buyer & seller\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    // Buyer signed cancel
    {
        const deal = await sdk.getEscrowByIdParsed(escrowId);
        const nonce = await sdk.getUserNonce(escrowId, deal.buyer);
        const deadline = await sdk.createSignatureDeadline(60);
        const msg = await (sdk as any).buildRequestCancelMessage(
            escrowId,
            deadline,
            nonce,
        );

        const signature = await buyerWalletClient.signTypedData({
            account: buyerWalletClient.account!,
            domain: (sdk as any).getEip712Domain(),
            types: (sdk as any).requestCancelTypes,
            primaryType: "RequestCancel",
            message: msg,
        });

        await sdk.requestCancelSigned(
            buyerWalletClient,
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    }

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        "After buyer signed cancel only, still AWAITING_DELIVERY",
    );

    // Seller signed cancel
    {
        const deal = await sdk.getEscrowByIdParsed(escrowId);
        const nonce = await sdk.getUserNonce(escrowId, deal.seller);
        const deadline = await sdk.createSignatureDeadline(60);
        const msg = await (sdk as any).buildRequestCancelMessage(
            escrowId,
            deadline,
            nonce,
        );

        const signature = await sellerWalletClient.signTypedData({
            account: sellerWalletClient.account!,
            domain: (sdk as any).getEip712Domain(),
            types: (sdk as any).requestCancelTypes,
            primaryType: "RequestCancel",
            message: msg,
        });

        await sdk.requestCancelSigned(
            sellerWalletClient,
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    }

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(status.stateName === "CANCELED", "Signed mutual cancel → CANCELED");

    console.log("✅ TEST passed: requestCancelSigned – buyer & seller\n");
}

async function testCancelByTimeout() {
    console.log("\nTEST: cancelByTimeout – after grace period\n");

    // Maturity 0 to allow immediate cancel after grace
    const escrowId = await createEscrow(0n);
    await testDepositEscrow(escrowId);

    // Buyer requests cancel
    await sdk.requestCancel(buyerWalletClient, escrowId);

    // Increase time beyond GRACE_PERIOD (from contract, e.g. 7h)
    await increaseTime(7 * 60 * 60); // adjust if your GRACE_PERIOD differs [sec]

    // Buyer cancels by timeout
    await sdk.cancelByTimeout(buyerWalletClient, escrowId);

    const status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(status.stateName === "CANCELED", "cancelByTimeout → CANCELED");

    console.log("✅ TEST passed: cancelByTimeout – after grace period\n");
}

async function testStartDispute() {
    console.log("\nTEST: startDispute – on‑chain\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    await sdk.startDispute(buyerWalletClient, escrowId);

    const status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "DISPUTED",
        `Expected DISPUTED, got ${status.stateName}`,
    );

    console.log("✅ TEST passed: startDispute – on‑chain\n");
}

async function testStartDisputeSignedRoles() {
    console.log("\nTEST: startDisputeSigned – roles\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    const deal = await sdk.getEscrowByIdParsed(escrowId);

    // Buyer signed dispute
    {
        const nonce = await sdk.getUserNonce(escrowId, deal.buyer);
        const deadline = await sdk.createSignatureDeadline(60);
        const msg = await (sdk as any).buildStartDisputeMessage(
            escrowId,
            deadline,
            nonce,
        );

        const signature = await buyerWalletClient.signTypedData({
            account: buyerWalletClient.account!,
            domain: (sdk as any).getEip712Domain(),
            types: (sdk as any).startDisputeTypes,
            primaryType: "StartDispute",
            message: msg,
        });

        await sdk.startDisputeSigned(
            buyerWalletClient,          // msg.sender == buyer
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );

        const s = await sdk.getEscrowStatus(escrowId, true);
        console.assert(s.stateName === "DISPUTED", "Buyer startDisputeSigned → DISPUTED");
    }

    // Wrong role: arbiter signs and/or sends
    let err: any;
    try {
        const nonce = await sdk.getUserNonce(escrowId, deal.arbiter);
        const deadline = await sdk.createSignatureDeadline(60);
        const msg = await (sdk as any).buildStartDisputeMessage(
            escrowId,
            deadline,
            nonce,
        );

        const signature = await arbiterWalletClient.signTypedData({
            account: arbiterWalletClient.account!,
            domain: (sdk as any).getEip712Domain(),
            types: (sdk as any).startDisputeTypes,
            primaryType: "StartDispute",
            message: msg,
        });

        await sdk.startDisputeSigned(
            arbiterWalletClient,        // msg.sender == arbiter (not allowed)
            escrowId,
            signature as Hex,
            deadline,
            nonce,
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        (err?.details?.originalError?.shortMessage ?? "").includes("Unauthorized signer") ||
        err?.code === SDKErrorCode.INVALID_ROLE,
        "Arbiter startDisputeSigned should fail",
    );

    console.log("✅ TEST passed: startDisputeSigned – roles\n");
}

async function testSubmitDisputeMessageRolesAndDuplicate() {
    console.log("\nTEST: submitDisputeMessage – roles & duplicate\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    await sdk.startDispute(buyerWalletClient, escrowId);

    // Buyer message
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        "QmBuyerEvidence",
    );

    // Seller message
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        "QmSellerEvidence",
    );

    const status = await sdk.getDisputeSubmissionStatus(escrowId);
    console.assert(status.buyer, "Buyer submitted");
    console.assert(status.seller, "Seller submitted");
    console.assert(!status.arbiter, "Arbiter not submitted via submitDisputeMessage");
    console.assert(!status.allSubmitted, "allSubmitted should be false without arbiter");

    // Duplicate buyer evidence
    let err: any;
    try {
        await sdk.submitDisputeMessage(
            buyerWalletClient,
            escrowId,
            Role.Buyer,
            "QmBuyerAgain",
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        err?.code === SDKErrorCode.EVIDENCE_ALREADY_SUBMITTED,
        "Duplicate buyer evidence should fail",
    );

    console.log("✅ TEST passed: submitDisputeMessage – roles & duplicate\n");
}

async function testSubmitArbiterDecisionCompleteAndRefunded() {
    console.log("\nTEST: submitArbiterDecision – Complete & Refunded\n");

    // COMPLETE path – payout to seller
    {
        const escrowId = await createEscrow(7n);
        await testDepositEscrow(escrowId);
        await sdk.startDispute(buyerWalletClient, escrowId);

        const deal = await sdk.getEscrowByIdParsed(escrowId);

        // Full evidence: buyer + seller
        await sdk.submitDisputeMessage(
            buyerWalletClient,
            escrowId,
            Role.Buyer,
            "QmBuyerEvidenceForComplete",
        );
        await sdk.submitDisputeMessage(
            sellerWalletClient,
            escrowId,
            Role.Seller,
            "QmSellerEvidenceForComplete",
        );

        const seller = deal.seller;
        const buyer = deal.buyer;

        const sellerBefore = await sdk.getTokenBalanceOf(seller, deal.token);
        const buyerBefore = await sdk.getTokenBalanceOf(buyer, deal.token);

        await sdk.submitArbiterDecision(
            arbiterWalletClient,
            escrowId,
            DisputeResolution.Complete,
            "QmDecisionComplete",
        );

        const status = await sdk.getEscrowStatus(escrowId, true);
        console.assert(status.stateName === "COMPLETE", "Decision Complete → COMPLETE");

        const sellerAfter = await sdk.getTokenBalanceOf(seller, deal.token);
        const buyerAfter = await sdk.getTokenBalanceOf(buyer, deal.token);

        console.assert(
            sellerAfter > sellerBefore,
            "Seller should receive funds on Complete",
        );
        console.assert(
            buyerAfter <= buyerBefore,
            "Buyer should not gain on Complete",
        );
    }

    // REFUNDED path – payout to buyer
    {
        const escrowId = await createEscrow(7n);
        await testDepositEscrow(escrowId);
        await sdk.startDispute(buyerWalletClient, escrowId);

        const deal = await sdk.getEscrowByIdParsed(escrowId);

        // Full evidence: buyer + seller
        await sdk.submitDisputeMessage(
            buyerWalletClient,
            escrowId,
            Role.Buyer,
            "QmBuyerEvidenceForRefunded",
        );
        await sdk.submitDisputeMessage(
            sellerWalletClient,
            escrowId,
            Role.Seller,
            "QmSellerEvidenceForRefunded",
        );

        const seller = deal.seller;
        const buyer = deal.buyer;

        const sellerBefore = await sdk.getTokenBalanceOf(seller, deal.token);
        const buyerBefore = await sdk.getTokenBalanceOf(buyer, deal.token);

        await sdk.submitArbiterDecision(
            arbiterWalletClient,
            escrowId,
            DisputeResolution.Refunded,
            "QmDecisionRefunded",
        );

        const status = await sdk.getEscrowStatus(escrowId, true);
        console.assert(status.stateName === "REFUNDED", "Decision Refunded → REFUNDED");

        const sellerAfter = await sdk.getTokenBalanceOf(seller, deal.token);
        const buyerAfter = await sdk.getTokenBalanceOf(buyer, deal.token);

        console.assert(
            buyerAfter > buyerBefore,
            "Buyer should receive refund",
        );
        console.assert(
            sellerAfter <= sellerBefore,
            "Seller should not gain on Refund",
        );
    }

    console.log("✅ TEST passed: submitArbiterDecision – Complete & Refunded\n");
}

async function testSubmitArbiterDecisionInvalidRoleAndTimeout() {
    console.log("\nTEST: submitArbiterDecision – invalid role & timeout\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);

    // Buyer evidence first, so "Need evidence or timeout" is satisfied later
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        "QmBuyerEvidenceForTimeoutTest",
    );

    // Invalid role: buyer tries to decide
    let err: any;
    try {
        await sdk.submitArbiterDecision(
            buyerWalletClient,
            escrowId,
            DisputeResolution.Complete,
            "QmInvalid",
        );
    } catch (e) {
        err = e;
    }

    console.assert(
        err?.code === SDKErrorCode.INVALID_ROLE,
        "Non‑arbiter decision should fail with INVALID_ROLE",
    );

    // Timeout: long time passes, arbiter can still decide
    await increaseTime(31 * 24 * 60 * 60); // > 30 days

    await sdk.submitArbiterDecision(
        arbiterWalletClient,
        escrowId,
        DisputeResolution.Refunded,
        "QmTimeoutDecision",
    );

    const status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "REFUNDED",
        "Arbiter can decide after long timeout (with evidence)",
    );

    console.log("✅ TEST passed: submitArbiterDecision – invalid role & timeout\n");
}


async function testSimulation() {
    console.log("\nTEST: simulateTransaction – success & revert\n");

    const escrowId = await createEscrow(7n);

    // Before deposit: should succeed
    const simOk = await sdk.simulateTransaction(
        buyerWalletClient,
        "deposit",
        [escrowId],
    );
    console.assert(simOk.success && simOk.gasEstimate! > 0n, "Simulation should succeed before deposit");

    // After deposit: should revert (not awaiting payment)
    await testDepositEscrow(escrowId);
    const simFail = await sdk.simulateTransaction(
        buyerWalletClient,
        "deposit",
        [escrowId],
    );
    console.assert(!simFail.success, "Simulation should fail after deposit");
    console.assert(
        (simFail.revertReason ?? "").length > 0,
        "Should capture revert reason",
    );

    console.log("✅ TEST passed: simulateTransaction – success & revert\n");
}


async function testCacheForceRefresh() {
    console.log("\nTEST: cache – forceRefresh\n");

    const escrowId = await createEscrow(7n);

    // First read goes to chain & caches
    const s1 = await sdk.getEscrowStatus(escrowId);
    // Change state
    await testDepositEscrow(escrowId);
    // Cached read still old
    const s2 = await sdk.getEscrowStatus(escrowId);
    console.assert(s1.stateName === s2.stateName, "Cached status unchanged");
    // Force refresh sees new state
    const s3 = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        s3.stateName === "AWAITING_DELIVERY",
        "forceRefresh should bypass cache",
    );

    console.log("✅ TEST passed: cache – forceRefresh\n");
}

async function testCacheStats() {
    console.log("\nTEST: cache – stats & clear\n");

    await createEscrow(7n);
    await sdk.getEscrowStatus(1n).catch(() => { });

    const stats = sdk.getCacheStats();
    console.assert(stats.escrowCacheSize > 0, "escrow cache has entries");

    sdk.clearAllCaches();
    const empty = sdk.getCacheStats();
    console.assert(
        empty.escrowCacheSize === 0 && empty.tokenDecimalsCacheSize === 0,
        "caches cleared",
    );

    console.log("✅ TEST passed: cache – stats & clear\n");
}


async function testTokenAndMaturityHelpers() {
    console.log("\nTEST: token & maturity helpers\n");

    const escrowId = await createEscrow(1n);
    await testDepositEscrow(escrowId);

    const deal = await sdk.getEscrowByIdParsed(escrowId);

    const decimals = await sdk.getTokenDecimals(deal.token);
    console.assert(decimals > 0, "Token decimals > 0");

    const info = sdk.getMaturityInfo(deal.depositTime, 1n);
    console.assert(info.hasDeadline, "hasDeadline true");
    console.assert(!info.isPassed, "not passed immediately");
    console.assert(info.maturityDays === 1, "maturityDays = 1");

    console.log("✅ TEST passed: token & maturity helpers\n");
}

async function testUserBalances() {
    console.log("\nTEST: getUserBalances\n");

    // Ensure buyer is funded with USDT
    await fundBuyer();

    const balances = await sdk.getUserBalances(buyerAccount.address, [USDT]);

    const entry = balances.get(USDT);
    console.assert(entry !== undefined, "USDT entry present");
    console.assert(entry!.balance > 0n, "Buyer USDT balance > 0");

    console.log("✅ TEST passed: getUserBalances\n");
}

async function testHasSubmittedEvidence() {
    console.log("\nTEST: hasSubmittedEvidence\n");

    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);
    await sdk.startDispute(buyerWalletClient, escrowId);

    // Initially: no evidence
    let buyerHas = await sdk.hasSubmittedEvidence(escrowId, Role.Buyer);
    let sellerHas = await sdk.hasSubmittedEvidence(escrowId, Role.Seller);
    let arbiterHas = await sdk.hasSubmittedEvidence(escrowId, Role.Arbiter);

    console.assert(!buyerHas && !sellerHas && !arbiterHas, "No evidence initially");

    // Buyer submits
    await sdk.submitDisputeMessage(
        buyerWalletClient,
        escrowId,
        Role.Buyer,
        "QmBuyerEvidence_bitmap",
    );

    buyerHas = await sdk.hasSubmittedEvidence(escrowId, Role.Buyer);
    sellerHas = await sdk.hasSubmittedEvidence(escrowId, Role.Seller);

    console.assert(buyerHas, "Buyer evidence bit set");
    console.assert(!sellerHas, "Seller evidence bit not set");

    // Seller submits
    await sdk.submitDisputeMessage(
        sellerWalletClient,
        escrowId,
        Role.Seller,
        "QmSellerEvidence_bitmap",
    );

    sellerHas = await sdk.hasSubmittedEvidence(escrowId, Role.Seller);
    console.assert(sellerHas, "Seller evidence bit set");

    console.log("✅ TEST passed: hasSubmittedEvidence\n");
}


async function testWatchUserEscrows() {
    console.log("\nTEST: watchUserEscrows\n");

    const buyer = buyerWalletClient.account.address as Address;
    const seller = sellerWalletClient.account.address as Address;
    const TIMEOUT_MS = 10_000;

    let latest: { escrowId: bigint; event: EscrowCreatedEvent } | any = null;

    const watcher = sdk.watchUserEscrows(
        buyer,
        (escrowId, event) => {
            console.log("watchUserEscrows callback escrowId:", escrowId.toString());
            latest = { escrowId, event };
        },
        {
            // optional but safer on Hardhat if other tests emitted events
            // fromBlock: BigInt(await publicClient.getBlockNumber() + 1n),
        },
    );

    try {
        // 1) Create an escrow that should emit EscrowCreated(buyer, seller)
        const escrowId = await createEscrow(7n);
        await testDepositEscrow(escrowId); // if this emits the event instead, that's fine

        // 2) Wait until watcher sees it or timeout
        const start = Date.now();
        while (latest === null && Date.now() - start < TIMEOUT_MS) {
            console.log("latest EscrowCreated snapshot:", latest);
            await new Promise((r) => setTimeout(r, 200));
        }

        // 3) Real assertions (use assert instead of console.assert)
        assert.ok(
            latest !== null,
            "watchUserEscrows should receive at least one EscrowCreated event for buyer",
        );

        assert.equal(
            latest!.event.buyer.toLowerCase(),
            buyer.toLowerCase(),
            "Event buyer should match watched buyer address",
        );

        // if you care about seller side too
        assert.equal(
            latest!.event.seller.toLowerCase(),
            seller.toLowerCase(),
            "Event seller should match expected seller address",
        );

        console.log("✅ TEST passed: watchUserEscrows\n");
    } finally {
        watcher.dispose();
    }
}




// ────────────────────────────── MAIN RUNNER ──────────────────────────────

async function run() {
    console.log("=== PALINDROME ESCROW SDK – COVERAGE SUITE ===\n");

    await testHealthCheck();
    await testConfirmDeliverySigned();
    await testHappyPathFullFlow();
    await testExecuteEscrowERC20Split();
    await testConfirmDeliverySignedWrongSigner();
    await testConfirmDeliverySignedExpiredDeadline();
    await testRequestCancelMutual();
    await testRequestCancelSigned();
    await testCancelByTimeout();
    await testStartDispute();
    await testStartDisputeSignedRoles();
    await testSubmitDisputeMessageRolesAndDuplicate();
    await testSubmitArbiterDecisionCompleteAndRefunded();
    await testSubmitArbiterDecisionInvalidRoleAndTimeout();
    await testCacheForceRefresh();
    await testCacheStats();
    await testTokenAndMaturityHelpers();
    await testUserBalances();
    await testHasSubmittedEvidence();
    await testHappyPathFullFlow();
    await testWatchUserEscrows();



    console.log("\n====================================");
    console.log("CORE TESTS PASSED");
    console.log("====================================\n");
    process.exit(0);
}

void run().catch((err) => {
    console.error("TEST SUITE FAILED", err);
    process.exit(1);
});
