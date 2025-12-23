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

async function testConfirmDeliverySignedAsBuyer() {
    console.log("confirmDeliverySignedAsBuyer meta-tx with extra buyerSig/ipfsHaesh");

    // 1. Create escrow + deposit so state is AWAITING_DELIVERY
    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "AWAITING_DELIVERY",
        `Expected AWAITING_DELIVERY, got ${status.stateName}`,
    );

    // 2. Call the new high-level helper
    const txHash = await sdk.confirmDeliverySignedAsBuyer(
        buyerWalletClient,
        escrowId,
    );

    console.log("confirmDeliverySignedAsBuyer txHash:", txHash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

    // 3. Verify state is COMPLETE
    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === "COMPLETE",
        `Expected COMPLETE after confirmDeliverySignedAsBuyer, got ${status.stateName}`,
    );

    // 4. Parse DeliveryConfirmed event and assert ipfsHaesh is non-empty
    const events = parseEventLogs({
        abi: sdk.abiEscrow,
        logs: receipt.logs,
        eventName: "DeliveryConfirmed",
    }) as Array<{
        args: {
            escrowId: bigint;
            buyer: string;
            seller: string;
            amount: bigint;
            fee: bigint;
            ipfsHaesh: string;
        };
    }>;

    console.assert(
        events.length > 0,
        "DeliveryConfirmed event should be emitted",
    );

    const evt = events[0].args;
    console.assert(
        typeof evt.ipfsHaesh === "string" && evt.ipfsHaesh.length > 0,
        "ipfsHaesh (buyerSig) in DeliveryConfirmed event should be a non-empty string",
    );

    console.log("TEST passed confirmDeliverySignedAsBuyer");
}


async function testExecuteEscrowERC20SplitAsSeller() {
    console.log('executeEscrowERC20SplitAsSeller 2-of-3 multisig wallet');

    // 1. Create escrow + deposit so wallet is funded and AWAITING_DELIVERY
    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        `Must be AWAITING_DELIVERY, got ${status.stateName}`,
    );

    // 2. Resolve wallet & nonce
    const { wallet, nonce: walletNonce } = await sdk.getEscrowWalletAndNonce(escrowId);
    console.log('Wallet:', wallet, 'nonce:', walletNonce.toString());

    const deal = await sdk.getEscrowByIdParsed(escrowId);
    const token = deal.token as Address;
    const seller = deal.seller as Address;
    const buyer = deal.buyer as Address;

    // 3. Compute 1% fee & netAmount from deal.amount (for expectations only)
    const amount = deal.amount as bigint;
    const feeBps = 100n;       // 1%
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    const feeTo = (await publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    })) as Address;

    // 4. Snapshot balances
    const sellerBefore = await sdk.getTokenBalanceOf(seller, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);
    const walletBefore = await sdk.getTokenBalanceOf(wallet as Address, token);

    // 5. Build EIP-712 ExecuteSplit typed data and buyer co-signature
    const walletClient = new PalindromeEscrowWalletClient(publicClient, chain.id);

    const buyerSig: Hex = await walletClient.signExecuteSplit(buyerWalletClient, {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,
        feeTo,
        nonce: walletNonce,
    });

    // 6. Execute split as seller via SDK helper (seller signs inside helper)
    console.log('Executing 2-of-3 payout via seller...');
    const execTx = await sdk.withdrawSeller(
        sellerWalletClient, // executor: must be seller
        escrowId,
        buyerSig,
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    // 7. Check balances
    const sellerAfter = await sdk.getTokenBalanceOf(seller, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);
    const walletAfter = await sdk.getTokenBalanceOf(wallet as Address, token);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${sellerAfter - sellerBefore}, expected ${netAmount}`,
    );
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee recipient received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );
    console.assert(
        walletAfter === walletBefore - amount,
        `Wallet drained by ${walletBefore - walletAfter}, expected ${amount}`,
    );

    console.log('TEST passed executeEscrowERC20SplitAsSeller');
}

async function testExecuteEscrowERC20SplitAsSellerFullFlow() {
    console.log('FULL: executeEscrowERC20SplitAsSeller payout + fee receiver');

    // 1. Create escrow and deposit so we have funds in the wallet
    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        `Expected AWAITING_DELIVERY, got ${status.stateName}`,
    );

    const deal = await sdk.getEscrowByIdParsed(escrowId);
    const token = deal.token as Address;
    const seller = deal.seller as Address;
    const buyer = deal.buyer as Address;

    // 2. Confirm delivery via EIP-712 meta-tx on the coordinator
    const userNonce = await sdk.getUserNonce(escrowId, buyer);
    const deadline = await sdk.createSignatureDeadline(60);
    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        userNonce,
    );

    const confirmSig = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: 'ConfirmDelivery',
        message: msg,
    });

    const confirmTx = await sdk.confirmDeliverySigned(
        buyerWalletClient,
        escrowId,
        confirmSig as Hex,
        deadline,
        userNonce,
        '0x',
    );
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'COMPLETE',
        `Expected COMPLETE after confirm, got ${status.stateName}`,
    );

    const { wallet, nonce: walletNonce } = await sdk.getEscrowWalletAndNonce(
        escrowId,
    );
    console.log('Wallet:', wallet, 'nonce:', walletNonce.toString());

    // 4. Compute 1% fee & netAmount from deal.amount (must match escrow logic)
    const amount = deal.amount as bigint;
    const feeBps = 100n;
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    const feeTo = (await publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    })) as Address;

    console.assert(
        feeTo.toLowerCase() ===
        '0x90f79bf6eb2c4f870365e785982e1f101e93b906'.toLowerCase(),
        `feeTo mismatch, got ${feeTo}`,
    );

    // 5. Snapshot balances
    const sellerBefore = await sdk.getTokenBalanceOf(seller, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);
    const walletBefore = await sdk.getTokenBalanceOf(wallet as Address, token);

    // 6. Build EIP-712 ExecuteSplit typed data and buyer co-signature
    const walletClientHelper = new PalindromeEscrowWalletClient(
        publicClient,
        chain.id,
    );

    const params = {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,        // or buyer depending on state
        feeTo,             // the same address the wallet stored
        nonce: walletNonce // from await wallet.read.nonce()
    };

    const buyerSig = await walletClientHelper.signExecuteSplit(buyerWalletClient, params);

    // 7. Execute split as seller via SDK helper (seller signs inside helper)
    console.log('Executing 2-of-3 payout via seller...');
    const execTx = await sdk.withdrawSeller(
        sellerWalletClient, // executor (seller)
        escrowId,
        buyerSig,          // co-signer (buyer) EIP-712 sig over SAME struct
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    // 8. Check balances
    const sellerAfter = await sdk.getTokenBalanceOf(seller, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);
    const walletAfter = await sdk.getTokenBalanceOf(wallet as Address, token);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${sellerAfter - sellerBefore}, expected ${netAmount}`,
    );
    console.log('---------------------------');
    console.log(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${sellerAfter - sellerBefore}, expected ${netAmount}`,
    );
    console.log('---------------------------');
    console.log('---------------------------');
    console.log(
        `Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );
    console.log('---------------------------');
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );

    console.assert(
        walletBefore - walletAfter === amount,
        `Wallet drained by ${walletBefore - walletAfter}, expected ${amount}`,
    );

    console.log('TEST passed executeEscrowERC20SplitAsSeller full flow');
}

async function testExecuteEscrowERC20SplitAsBuyerFullFlow2() {
    console.log('\nFULL: executeEscrowERC20Split refund-to-buyer\n');

    const params: CreateEscrowParams = {
        token: USDT,
        buyer: buyerWalletClient.account.address,
        amount: 10n * ONE_USDT,
        maturityTimeDays: 0n,
        arbiter: arbiterAccount.address,
        title: "Coverage Test",
        ipfsHash: "QmCoverage...",
    };

    // 1. Create escrow + attach sellerSig
    const { escrowId, sellerSig } = await sdk.createEscrowWithSellerSig(sellerWalletClient, params);

    // 2. Deposit into escrow (existing helper)
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        `Expected AWAITING_DELIVERY, got ${status.stateName}`,
    );

    const deal = await sdk.getEscrowByIdParsed(escrowId);
    const { wallet } = await sdk.getEscrowWalletAndNonce(escrowId);
    const token = deal.token as Address;
    const buyer = deal.buyer as Address;

    const feeTo = await publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    }) as Address;

    // 3. Cancel (buyer + seller) so state becomes CANCELED (refund path)
    const tx1 = await sdk.requestCancel(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: tx1 });

    const tx2 = await sdk.requestCancel(sellerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: tx2 });

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'CANCELED',
        `Expected CANCELED, got ${status.stateName}`,
    );

    // 4. Expected amounts
    const amount = deal.amount as bigint;
    const feeBps = 100n;
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    // 5. Snapshot balances
    const buyerBefore = await sdk.getTokenBalanceOf(buyer, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);
    const walletBefore = await sdk.getTokenBalanceOf(wallet as Address, token);

    // 6. Buyer withdraws using sellerSig as co-signer
    const execTx = await sdk.withdrawBuyer(
        buyerWalletClient,
        escrowId,
        sellerSig, // co-signer (seller) ExecuteSplit sig with to=buyer
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    // 7. Check balances
    const buyerAfter = await sdk.getTokenBalanceOf(buyer, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);
    const walletAfter = await sdk.getTokenBalanceOf(wallet as Address, token);

    console.log(`Buyer received ${buyerAfter - buyerBefore}, expected ${netAmount}`);
    console.assert(
        buyerAfter - buyerBefore === netAmount,
        `Buyer received ${buyerAfter - buyerBefore}, expected ${netAmount}`,
    );
    console.log(`Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`);
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );
    console.log(`Wallet drained by ${walletBefore - walletAfter}, expected ${amount}`);
    console.assert(
        walletBefore - walletAfter === amount,
        `Wallet drained by ${walletBefore - walletAfter}, expected ${amount}`,
    );

    console.log('✅ TEST passed executeEscrowERC20SplitAsBuyerFullFlow\n');
}


async function testExecuteEscrowERC20SplitAsBuyerFullFlow() {
    console.log('FULL: executeEscrowERC20SplitAsSeller payout + fee receiver');

    // 1. Create escrow and deposit so we have funds in the wallet
    const id = await createEscrow(7n);

    const deal = await sdk.getEscrowByIdParsed(id);           // token, buyer, seller, wallet
    const { wallet, nonce } = await sdk.getEscrowWalletAndNonce(id);
    const token = deal.token as Address;

    const feeTo = await publicClient.readContract({
        address: sdk.contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    }) as Address;

    const walletClientHelper = new PalindromeEscrowWalletClient(publicClient, chain.id);

    const sellerSignature = await walletClientHelper.signExecuteSplit(sellerWalletClient, {
        wallet: wallet as Address,
        escrowId: id,
        token,
        to: deal.buyer as Address,   // because this flow is refund-to-buyer
        feeTo,
        nonce,
    });

    const txHash = await sellerWalletClient.writeContract({
        address: sdk.contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'attachSellerWalletSig',
        args: [id, sellerSignature],
        account: sellerWalletClient.account,
        chain: sellerWalletClient.chain,
    });
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });

    const logs = parseEventLogs({
        abi: sdk.abiEscrow,
        eventName: 'SellerWalletSigAttached',
        logs: receipt.logs,
    });

    const { escrowId, sellerSig } = logs[0].args as {
        escrowId: bigint;
        sellerSig: Hex;
    }

    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        `Expected AWAITING_DELIVERY, got ${status.stateName}`,
    );

    const seller = deal.seller as Address;
    const buyer = deal.buyer as Address;

    // // 2. Confirm delivery via EIP-712 meta-tx on the coordinator
    const userNonce = await sdk.getUserNonce(escrowId, buyer);
    const deadline = await sdk.createSignatureDeadline(60);
    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        userNonce,
    );

    const confirmSig = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: 'ConfirmDelivery',
        message: msg,
    });

    const confirmTx1 = await sdk.requestCancel(buyerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: confirmTx1 });
    const confirmTx2 = await sdk.requestCancel(sellerWalletClient, escrowId);
    await publicClient.waitForTransactionReceipt({ hash: confirmTx2 });

    status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'CANCELED',
        `Expected CANCELED after confirm, got ${status.stateName}`,
    );

    // 4. Compute 1% fee & netAmount from deal.amount (must match escrow logic)
    const amount = deal.amount as bigint;
    const feeBps = 100n;
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    console.assert(
        feeTo.toLowerCase() ===
        '0x90f79bf6eb2c4f870365e785982e1f101e93b906'.toLowerCase(),
        `feeTo mismatch, got ${feeTo}`,
    );

    // 5. Snapshot balances
    const buyerBefore = await sdk.getTokenBalanceOf(buyer, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);
    const walletBefore = await sdk.getTokenBalanceOf(wallet as Address, token);

    const params = {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,        // or buyer depending on state
        feeTo,             // the same address the wallet stored
        nonce // from await wallet.read.nonce()
    };

    // 7. Execute split as seller via SDK helper (seller signs inside helper)
    console.log('Executing 2-of-3 payout via seller...');
    const execTx = await sdk.withdrawBuyer(
        buyerWalletClient, // executor (seller)
        escrowId,
        sellerSig,          // co-signer (buyer) EIP-712 sig over SAME struct
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    // 8. Check balances
    const buyerAfter = await sdk.getTokenBalanceOf(buyer, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);
    const walletAfter = await sdk.getTokenBalanceOf(wallet as Address, token);

    console.assert(
        buyerAfter - buyerBefore === netAmount,
        `Buyer received ${buyerAfter - buyerBefore}, expected ${netAmount}`,
    );
    console.log('---------------------------');
    console.log(
        buyerAfter - buyerBefore === netAmount,
        `Buyer received ${buyerAfter - buyerBefore}, expected ${netAmount}`,
    );
    console.log('---------------------------');
    console.log('---------------------------');
    console.log(
        `Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );
    console.log('---------------------------');
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee receiver ${feeTo} received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );

    console.assert(
        walletBefore - walletAfter === amount,
        `Wallet drained by ${walletBefore - walletAfter}, expected ${amount}`,
    );

    console.log('TEST passed executeEscrowERC20SplitAsSeller full flow');
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
        ''
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
    console.log('\nHAPPY PATH: Full Flow (create → deposit → confirm → payout)\n');

    // 1. Create escrow and deposit so we have funds in the wallet
    const escrowId = await createEscrow(7n);
    console.log(`Escrow #${escrowId} created`);

    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        'After deposit: AWAITING_DELIVERY',
    );

    console.log('Buyer confirming delivery via signed meta-tx...');

    // 2. Confirm delivery via EIP-712 meta-tx on coordinator
    const buyerAddr = buyerWalletClient.account.address as Address;
    const userNonce = await sdk.getUserNonce(escrowId, buyerAddr);
    const deadline = await sdk.createSignatureDeadline(60);

    const msg = await (sdk as any).buildConfirmDeliveryMessage(
        escrowId,
        deadline,
        userNonce,
    );

    const confirmSig = await buyerWalletClient.signTypedData({
        account: buyerWalletClient.account!,
        domain: (sdk as any).getEip712Domain(),
        types: (sdk as any).confirmDeliveryTypes,
        primaryType: 'ConfirmDelivery',
        message: msg,
    });

    const confirmTx = await sdk.confirmDeliverySigned(
        buyerWalletClient,
        escrowId,
        confirmSig as Hex,
        deadline,
        userNonce,
        '0x', // not using ipfsHaesh channel here
    );
    await publicClient.waitForTransactionReceipt({ hash: confirmTx });
    console.log(`Confirmed: ${confirmTx}`);

    status = await sdk.getEscrowStatus(escrowId);
    console.assert(status.stateName === 'COMPLETE', 'After confirm: COMPLETE');

    // 3. Resolve wallet & wallet nonce
    const { wallet, nonce: walletNonce } = await sdk.getEscrowWalletAndNonce(
        escrowId,
    );
    console.log(`Wallet: ${wallet}, nonce: ${walletNonce}`);

    // 4. Compute fee & netAmount from deal.amount (must match escrow logic)
    const deal = await sdk.getEscrowByIdParsed(escrowId);
    const token = deal.token as Address;
    const amount = deal.amount as bigint;

    const feeBps = 100n; // 1%
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    // Use protocol feeTo, not arbiter
    const feeTo = (await publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    })) as Address;

    const seller = sellerWalletClient.account.address as Address;

    // 5. Snapshot balances
    const sellerBefore = await sdk.getTokenBalanceOf(seller, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);
    const walletBefore = await sdk.getTokenBalanceOf(wallet as Address, token);

    // 6. Build EIP-712 ExecuteSplit typed data and get buyer & seller signatures
    const walletClientHelper = new PalindromeEscrowWalletClient(
        publicClient,
        chain.id,
    );

    const buyerSig = await walletClientHelper.signExecuteSplit(buyerWalletClient, {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,
        feeTo,
        nonce: walletNonce,
    });

    const sellerSig = await walletClientHelper.signExecuteSplit(
        sellerWalletClient,
        {
            wallet: wallet as Address,
            escrowId,
            token,
            to: seller,
            feeTo,
            nonce: walletNonce,
        },
    );

    const signatures: [Hex, Hex, Hex] = [buyerSig, sellerSig, '0x'];

    // 7. Execute 2-of-3 payout directly via wallet (buyer executes here; could be seller)
    console.log('Executing 2-of-3 payout...');
    const execTx = await walletClientHelper.executeERC20Split(
        buyerWalletClient,
        wallet as Address,
        seller,
        signatures,
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });
    console.log(`Payout executed: ${execTx}`);

    // 8. Check balances
    const sellerAfter = await sdk.getTokenBalanceOf(seller, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);
    const walletAfter = await sdk.getTokenBalanceOf(wallet as Address, token);

    console.log(walletBefore, walletAfter);
    console.log(sellerBefore, sellerAfter);
    console.log(feeBefore, feeAfter);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${sellerAfter - sellerBefore}, expected ${netAmount}`,
    );
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee recipient received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );
    console.assert(walletAfter === 0n, 'Wallet drained');

    const receipt = await publicClient.getTransactionReceipt({ hash: execTx });
    const payoutLogs = parseEventLogs({
        abi: PalindromeEscrowWalletABI.abi,
        logs: receipt.logs,
        eventName: 'SplitExecuted',
    });
    console.assert(payoutLogs.length > 0, 'SplitExecuted event emitted');

    const { nonce: nonceAfter } = await sdk.getEscrowWalletAndNonce(escrowId);
    console.assert(
        nonceAfter === walletNonce + 1n,
        'Wallet nonce incremented',
    );

    console.log('\nHAPPY PATH TEST PASSED: Full flow completed\n');
}


async function testExecuteEscrowERC20Split() {
    console.log('\nTEST: executeEscrowERC20Split (2-of-3 multisig wallet)\n');

    // 1. Create escrow & deposit
    const escrowId = await createEscrow(7n);
    await testDepositEscrow(escrowId);

    let status = await sdk.getEscrowStatus(escrowId, true);
    console.assert(
        status.stateName === 'AWAITING_DELIVERY',
        'Must be AWAITING_DELIVERY',
    );

    // 2. Resolve wallet & wallet nonce
    const { wallet, nonce: walletNonce } = await sdk.getEscrowWalletAndNonce(escrowId);
    console.log('Wallet:', wallet, 'nonce:', walletNonce.toString());

    const deal = await sdk.getEscrowByIdParsed(escrowId);
    const token = deal.token as Address;
    const seller = sellerWalletClient.account.address as Address;

    // Compute expected net/fee from deal.amount (must match wallet ctor)
    const amount = deal.amount as bigint;
    const feeBps = 100n; // 1%
    const bpsDenom = 10_000n;
    let feeAmount = (amount * feeBps) / bpsDenom;
    if (feeAmount === 0n) feeAmount = 1n;
    const netAmount = amount - feeAmount;

    const feeTo = (await publicClient.readContract({
        address: contractAddress,
        abi: sdk.abiEscrow,
        functionName: 'feeReceiver',
    })) as Address;

    // 3. Snapshot balances
    const sellerBefore = await sdk.getTokenBalanceOf(seller, token);
    const feeBefore = await sdk.getTokenBalanceOf(feeTo, token);

    // 4. Build EIP-712 ExecuteSplit typed data and collect 2 signatures
    const walletClient = new PalindromeEscrowWalletClient(publicClient, chain.id);

    const buyerSig: Hex = await walletClient.signExecuteSplit(buyerWalletClient, {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,
        feeTo,
        nonce: walletNonce,
    });

    const sellerSig: Hex = await walletClient.signExecuteSplit(sellerWalletClient, {
        wallet: wallet as Address,
        escrowId,
        token,
        to: seller,
        feeTo,
        nonce: walletNonce,
    });

    const signatures: [Hex, Hex, Hex] = [buyerSig, sellerSig, '0x'];

    // 5. Execute split directly via wallet
    const execTx = await walletClient.executeERC20Split(
        buyerWalletClient,        // any executor; must be an owner in your design if you enforce it
        wallet as Address,
        seller,
        signatures,
    );
    await publicClient.waitForTransactionReceipt({ hash: execTx });

    // 6. Check balances
    const sellerAfter = await sdk.getTokenBalanceOf(seller, token);
    const feeAfter = await sdk.getTokenBalanceOf(feeTo, token);

    console.assert(
        sellerAfter - sellerBefore === netAmount,
        `Seller received ${sellerAfter - sellerBefore}, expected ${netAmount}`,
    );
    console.assert(
        feeAfter - feeBefore === feeAmount,
        `Fee recipient received ${feeAfter - feeBefore}, expected ${feeAmount}`,
    );

    console.log('\nTEST PASSED: executeEscrowERC20Split\n');
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
            ''
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
            ''
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
        ''
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
            ''
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

async function testCancelByTimeout() {
    console.log("\nTEST: cancelByTimeout – after grace period\n");

    // Maturity 0 to allow immediate cancel after grace
    const escrowId = await createEscrow(0n);
    await testDepositEscrow(escrowId);

    // Buyer requests cancel
    await sdk.requestCancel(buyerWalletClient, escrowId);

    // Increase time beyond GRACE_PERIOD (from contract, e.g. 7h)
    await increaseTime(72 * 60 * 60); // adjust if your GRACE_PERIOD differs [sec]

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
        await increaseTime(72 * 60 * 60);

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

        await increaseTime(72 * 60 * 60);

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
    await testExecuteEscrowERC20SplitAsBuyerFullFlow2();
    await testConfirmDeliverySignedAsBuyer();
    await testExecuteEscrowERC20SplitAsSellerFullFlow()
    await testExecuteEscrowERC20SplitAsBuyerFullFlow()
    await testHappyPathFullFlow();
    await testConfirmDeliverySignedWrongSigner();
    await testConfirmDeliverySigned();
    await testConfirmDeliverySignedExpiredDeadline();
    await testRequestCancelMutual();
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
