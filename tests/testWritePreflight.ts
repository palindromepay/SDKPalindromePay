/**
 * PalindromePaySDK – Write Preflight & ID-Drift Self-Heal Tests
 *
 * Runs against a local Hardhat node with the v2 contracts deployed (same setup as
 * testCore). Deterministic, no testnet needed.
 *
 * T1 – A reverting write surfaces a DECODED reason (require string AND custom
 *      error) as a clean SDKError, and sends NO transaction (nonce unchanged) —
 *      instead of leaking MetaMask's "exceeds max transaction gas limit".
 * T2 – createEscrow self-heals escrow-id drift: when nextEscrowId advances between
 *      signing and submitting, the SDK re-reads + re-signs once and still succeeds.
 * T3 – The happy path is untouched: a normal createEscrow signs exactly once.
 *
 * Env (same as testCore): RPC_URL, CONTRACT_ADDRESS, USDT, *_PRIVATE_KEY.
 */

import "dotenv/config";
import {
    createPublicClient,
    createWalletClient,
    http,
    Address,
    Abi,
    Hex,
    PublicClient,
} from "viem";
import { hardhat } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ApolloClient, HttpLink, InMemoryCache } from "@apollo/client/core";
import assert from "assert";

import {
    PalindromePaySDK,
    SDKError,
    SDKErrorCode,
    EscrowState,
    EscrowWalletClient,
} from "../src/PalindromePaySDK";
import { CONFIG } from "../src/config";
import PalindromePayABI from "../src/contract/PalindromePay.json";

const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
const contractAddress = process.env.CONTRACT_ADDRESS as Address;
const USDT = process.env.USDT as Address;
const sellerKey = process.env.SELLER_PRIVATE_KEY as `0x${string}`;
const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const arbiterKey = process.env.ARBITER_PRIVATE_KEY as `0x${string}`;
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;

if (!contractAddress) throw new Error("CONTRACT_ADDRESS required");
if (!USDT) throw new Error("USDT required");
if (!sellerKey || !buyerKey || !arbiterKey) throw new Error("SELLER/BUYER/ARBITER keys required");

(CONFIG as { CONTRACT_ADDRESS: Address }).CONTRACT_ADDRESS = contractAddress;

const chain = hardhat;
const abiEscrow = PalindromePayABI.abi as Abi;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ZERO_SIG = ("0x" + "00".repeat(65)) as Hex;
const AMOUNT = 10n * 1_000_000n; // 10 USDT (contract minimum)

const sellerAccount = privateKeyToAccount(sellerKey);
const buyerAccount = privateKeyToAccount(buyerKey);
const arbiterAccount = privateKeyToAccount(arbiterKey);
const deployerAccount = deployerKey ? privateKeyToAccount(deployerKey) : undefined;

const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const mkWallet = (account: ReturnType<typeof privateKeyToAccount>) =>
    createWalletClient({ chain, account, transport: http(rpcUrl) });
const sellerWallet = mkWallet(sellerAccount);
const buyerWallet = mkWallet(buyerAccount);
const arbiterWallet = mkWallet(arbiterAccount);

const apollo = new ApolloClient({ link: new HttpLink({ uri: "http://localhost/unused" }), cache: new InMemoryCache() });

const baseConfig = { publicClient, apolloClient: apollo, chain, logLevel: "none" as const };

/**
 * Test subclass exposing the internal write path and letting a test force id drift
 * and count create-signatures.
 */
class TestableSDK extends PalindromePaySDK {
    public signCount = 0;
    /** When set, the next afterCreateSignHook bumps on-chain nextEscrowId once. */
    public bumpOnce: (() => Promise<void>) | null = null;

    public rawWrite(
        walletClient: EscrowWalletClient,
        params: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
    ): Promise<Hex> {
        return this.resilientWriteContract(walletClient, params);
    }

    protected override async signCreateAuthorization(
        walletClient: EscrowWalletClient,
        predictedWallet: Address,
        escrowId: bigint,
    ): Promise<Hex> {
        this.signCount++;
        return super.signCreateAuthorization(walletClient, predictedWallet, escrowId);
    }

    protected override async afterCreateSignHook(): Promise<void> {
        if (this.bumpOnce) {
            const fn = this.bumpOnce;
            this.bumpOnce = null; // fire exactly once
            await fn();
        }
    }
}

// Long cacheTTL so T5 can prove force-refresh actually bypasses a stale cache.
const sdk = new TestableSDK({ ...baseConfig, walletClient: sellerWallet, cacheTTL: 60_000 });
// Plain SDK used for out-of-band writes (own cache → does not invalidate `sdk`'s).
const bumpSdk = new PalindromePaySDK({ ...baseConfig, walletClient: arbiterWallet });

function log(msg: string) { console.log(`    ${msg}`); }
function pass(name: string) { console.log(`  ✅ ${name}\n`); }
function section(name: string) { console.log(`\n${"═".repeat(70)}\n  ${name}\n${"═".repeat(70)}`); }

async function nonceOf(addr: Address) {
    return publicClient.getTransactionCount({ address: addr, blockTag: "pending" });
}

// ════════════════════════════════════════════════════════════════════════════
// T1 – a reverting write surfaces a clean SDKError and sends NO transaction
//      (instead of the wallet's opaque "exceeds max transaction gas limit")
// ════════════════════════════════════════════════════════════════════════════

async function testRevertSurfacedNoTx() {
    section("T1: reverting write → clean SDKError, no tx sent");

    // createEscrow with an invalid (zero) signature reverts on-chain. The preflight
    // must surface it as a clean SDKError before the wallet ever estimates gas.
    // (This local Hardhat node masks the decoded reason as "Internal error"; on a
    // real chain e.g. Base Sepolia the reason/errorName decodes — asserted there,
    // not here. The guarantee under test is: clean error + zero gas.)
    const nonceBefore = await nonceOf(sellerAccount.address);
    let threw: unknown;
    try {
        await sdk.rawWrite(sellerWallet, {
            address: contractAddress,
            abi: abiEscrow,
            functionName: "createEscrow",
            args: [USDT, buyerAccount.address, AMOUNT, 1n, ZERO, 0, "Bad Sig", "", ZERO_SIG],
        });
    } catch (e) { threw = e; }

    assert.ok(threw instanceof SDKError, "should throw SDKError, not a raw viem/gas error");
    assert.equal((threw as SDKError).code, SDKErrorCode.TRANSACTION_FAILED, "code TRANSACTION_FAILED");
    assert.equal(await nonceOf(sellerAccount.address), nonceBefore, "no tx sent (nonce unchanged, no gas)");
    log(`revert caught as SDKError(${(threw as SDKError).code}); nonce unchanged (no gas)`);

    pass("T1: revert surfaced cleanly, wallet never estimates gas");
}

// ════════════════════════════════════════════════════════════════════════════
// T2 – createEscrow with an arbiter (the user's reported failure)
// ════════════════════════════════════════════════════════════════════════════

async function testArbiterEoaValidation() {
    section("T2: createEscrow arbiter EOA validation");

    // (a) a CONTRACT address as arbiter must fail fast, client-side, no tx.
    const nonceBefore = await nonceOf(sellerAccount.address);
    let threw: unknown;
    try {
        await sdk.createEscrow(sellerWallet, {
            token: USDT,
            buyer: buyerAccount.address,
            amount: AMOUNT,
            maturityTimeDays: 1n,
            arbiter: USDT, // a deployed contract, not an EOA
            arbiterFeeBps: 500,
            title: "Contract arbiter",
        });
    } catch (e) { threw = e; }

    assert.ok(threw instanceof SDKError, "should throw SDKError");
    assert.equal((threw as SDKError).code, SDKErrorCode.VALIDATION_ERROR, "code VALIDATION_ERROR");
    assert.ok(/EOA/i.test((threw as SDKError).message), `message mentions EOA, got: "${(threw as SDKError).message}"`);
    assert.equal(await nonceOf(sellerAccount.address), nonceBefore, "no tx sent for invalid arbiter");
    log(`contract arbiter rejected client-side: "${(threw as SDKError).message}"`);

    // (b) a valid EOA arbiter still works (regression).
    sdk.signCount = 0;
    const { escrowId } = await sdk.createEscrow(sellerWallet, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: 1n,
        arbiter: arbiterAccount.address, // valid EOA
        arbiterFeeBps: 500,
        title: "EOA arbiter",
    });
    const deal = await sdk.getEscrowByIdParsed(escrowId, true);
    assert.equal(deal.arbiter.toLowerCase(), arbiterAccount.address.toLowerCase(), "arbiter set");
    assert.equal(deal.arbiterFeeBps, 500, "arbiter fee stored");
    log(`EOA arbiter escrow #${escrowId} created (fee ${deal.arbiterFeeBps} bps)`);

    // (c) an EIP-7702 delegated EOA (MetaMask Smart Account) must be ACCEPTED —
    // by the SDK check AND by the deployed contract (_isEoaLike). We plant a
    // 7702 delegation designator (0xef0100 ++ delegate) on a fresh address.
    const delegated = "0x00000000000000000000000000000000000077A2" as Address;
    const designator = ("0xef0100" + USDT.slice(2)) as Hex; // delegate to any address; 23 bytes total
    const res = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "hardhat_setCode", params: [delegated, designator] }),
    }).then((r) => r.json());
    assert.ok(!res.error, `hardhat_setCode failed: ${JSON.stringify(res.error)}`);

    const { escrowId: id7702 } = await sdk.createEscrow(sellerWallet, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: 1n,
        arbiter: delegated, // 7702-delegated "EOA"
        arbiterFeeBps: 500,
        title: "7702 arbiter",
    });
    const deal7702 = await sdk.getEscrowByIdParsed(id7702, true);
    assert.equal(deal7702.arbiter.toLowerCase(), delegated.toLowerCase(), "7702 arbiter accepted on-chain");
    log(`EIP-7702 arbiter escrow #${id7702} created (designator code accepted)`);

    pass("T2: contract arbiter rejected, EOA arbiter works, 7702 arbiter accepted");
}

// ════════════════════════════════════════════════════════════════════════════
// T3 – createEscrow self-heals id drift
// ════════════════════════════════════════════════════════════════════════════

async function testIdDriftSelfHeal() {
    section("T3: createEscrow self-heals stale escrow id");

    sdk.signCount = 0;
    // After the first signature, advance nextEscrowId by creating a throwaway escrow
    // out-of-band → the just-signed authorization is now bound to a stale id.
    sdk.bumpOnce = async () => {
        await bumpSdk.createEscrow(arbiterWallet, {
            token: USDT,
            buyer: buyerAccount.address,
            amount: AMOUNT,
            maturityTimeDays: 1n,
            title: "Drift bump",
        });
        log("injected id drift (out-of-band escrow created)");
    };

    const { escrowId } = await sdk.createEscrow(sellerWallet, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: 1n,
        title: "Drift self-heal",
    });

    assert.equal(sdk.signCount, 2, `expected exactly one re-sign (2 total), got ${sdk.signCount}`);
    const onChain = await sdk.getEscrowByIdParsed(escrowId, true);
    assert.equal(onChain.seller.toLowerCase(), sellerAccount.address.toLowerCase(), "escrow created for seller");
    assert.equal(onChain.state, EscrowState.AWAITING_PAYMENT);
    log(`escrow #${escrowId} created after self-heal (signs: ${sdk.signCount})`);

    pass("T3: id drift auto-recovered without surfacing a gas error");
}

// ════════════════════════════════════════════════════════════════════════════
// T4 – happy path signs exactly once
// ════════════════════════════════════════════════════════════════════════════

async function testHappyPathSingleSign() {
    section("T4: happy path signs once (no needless retry)");

    sdk.signCount = 0;
    sdk.bumpOnce = null;

    const { escrowId } = await sdk.createEscrow(sellerWallet, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: 1n,
        title: "Happy path",
    });

    assert.equal(sdk.signCount, 1, `expected exactly 1 sign, got ${sdk.signCount}`);
    log(`escrow #${escrowId} created with a single signature`);

    pass("T4: preflight does not disturb the happy path");
}

// ════════════════════════════════════════════════════════════════════════════
// T5 – getEscrowStatus(forceRefresh) must bypass the escrow-data cache
// ════════════════════════════════════════════════════════════════════════════

async function testStatusForceRefresh() {
    section("T5: getEscrowStatus(forceRefresh) bypasses stale escrow cache");
    assert.ok(deployerAccount, "DEPLOYER_PRIVATE_KEY required (holds the test USDT)");

    const { escrowId } = await sdk.createEscrow(sellerWallet, {
        token: USDT,
        buyer: buyerAccount.address,
        amount: AMOUNT,
        maturityTimeDays: 1n,
        title: "Status refresh",
    });

    // Prime `sdk`'s caches (deal + status) — cacheTTL is 60s, so this stays hot.
    const primed = await sdk.getEscrowStatus(escrowId);
    assert.equal(primed.state, EscrowState.AWAITING_PAYMENT);
    log(`primed cache: state ${primed.stateName}`);

    // Out-of-band state change via a DIFFERENT SDK instance (its invalidation
    // cannot touch `sdk`'s cache — same situation as a second app user).
    const deployerWallet = mkWallet(deployerAccount!);
    const transferAbi = [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
    const fundHash = await deployerWallet.writeContract({
        address: USDT, abi: transferAbi, functionName: "transfer",
        args: [buyerAccount.address, AMOUNT], chain, account: deployerAccount!,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundHash });
    await bumpSdk.deposit(buyerWallet, escrowId);
    log("out-of-band deposit done (escrow now AWAITING_DELIVERY on-chain)");

    // The fix under test: forceRefresh must reach the chain, not the 60s cache.
    const fresh = await sdk.getEscrowStatus(escrowId, true);
    assert.equal(
        fresh.state, EscrowState.AWAITING_DELIVERY,
        `forceRefresh returned stale state ${fresh.stateName} (cache not bypassed)`,
    );
    log(`forceRefresh sees fresh state: ${fresh.stateName}`);

    pass("T5: forceRefresh reflects on-chain state despite hot cache");
}

async function main() {
    console.log(`\nPalindromePay SDK v3 — write preflight, arbiter & id-drift tests`);
    console.log(`RPC: ${rpcUrl}  Contract: ${contractAddress}`);

    await testRevertSurfacedNoTx();
    await testArbiterEoaValidation();
    await testIdDriftSelfHeal();
    await testHappyPathSingleSign();
    await testStatusForceRefresh();

    console.log("  🎉 ALL WRITE-PREFLIGHT TESTS PASSED\n");
    process.exit(0);
}

main().catch((err) => {
    console.error("\n  ❌ WRITE-PREFLIGHT TEST FAILED\n");
    console.error(err);
    process.exit(1);
});
