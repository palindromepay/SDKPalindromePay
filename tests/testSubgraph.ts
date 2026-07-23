/**
 * PalindromePaySDK – Goldsky Subgraph Test (Base Sepolia, Multisig v2)
 *
 * Verifies the deployed subgraph through the SDK's own query methods:
 *
 * Part 1 (gas-free): endpoint health — reachable, no indexing errors,
 *   indexed past the deployment startBlock, acceptable head lag.
 * Part 2 (gas-free): SDK queries (getEscrowDetail/getEscrows) against the
 *   v2 schema, plus a field-by-field comparison of escrow #0 between the
 *   subgraph and the on-chain contract (catches handler/schema drift).
 * Part 3 (RUN_LIVE=1, costs seller gas): create a fresh escrow on Sepolia
 *   and poll until the subgraph indexes it — proves live event ingestion
 *   with the new outcome-bearing event topics end-to-end.
 *
 * Env:
 *   SUBGRAPH_URL        Goldsky endpoint (required)
 *   SEPOLIA_RPC_URL     default: https://sepolia.base.org
 *   SEPOLIA_USDT        Sepolia test token address (NOT the local hardhat USDT) [part 3 only]
 *   SELLER_PRIVATE_KEY / BUYER_PRIVATE_KEY           [part 3 only]
 *   RUN_LIVE=1          enable part 3
 */

import "dotenv/config";
import { createPublicClient, createWalletClient, http, Address, PublicClient } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { ApolloClient, HttpLink, InMemoryCache, gql } from "@apollo/client/core";
import assert from "assert";

import { PalindromePaySDK, EscrowState } from "../src/PalindromePaySDK";

// ════════════════════════════════════════════════════════════════════════════
// ENV & CLIENTS
// ════════════════════════════════════════════════════════════════════════════

const subgraphUrl = process.env.SUBGRAPH_URL;
if (!subgraphUrl) throw new Error("SUBGRAPH_URL required");

const rpcUrl = process.env.SEPOLIA_RPC_URL ?? "https://sepolia.base.org";
const runLive = process.env.RUN_LIVE === "1";
// Deliberately NOT process.env.USDT — that one points at the local hardhat token
const USDT = process.env.SEPOLIA_USDT as Address | undefined;

const DEPLOY_START_BLOCK = 44520891n; // v2 deployment with EIP-7702 arbiter support

const chain = baseSepolia;
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;

const apollo = new ApolloClient({
    link: new HttpLink({ uri: subgraphUrl }),
    cache: new InMemoryCache(),
});

function makeWalletClient(pkEnv: string) {
    const pk = process.env[pkEnv] as `0x${string}` | undefined;
    if (!pk) return undefined;
    return createWalletClient({ chain, account: privateKeyToAccount(pk), transport: http(rpcUrl) });
}

const sellerWalletClient = makeWalletClient("SELLER_PRIVATE_KEY");
const buyerWalletClient = makeWalletClient("BUYER_PRIVATE_KEY");

const sdk = new PalindromePaySDK({
    publicClient,
    walletClient: sellerWalletClient,
    apolloClient: apollo,
    chain,
    testnet: true,
    receiptTimeout: 120_000,
});

// Subgraph stores state as the enum NAME string
const STATE_NAMES = [
    "AWAITING_PAYMENT", "AWAITING_DELIVERY", "DISPUTED", "COMPLETE", "REFUNDED", "CANCELED",
] as const;

function log(msg: string) { console.log(`    ${msg}`); }
function pass(name: string) { console.log(`  ✅ ${name}\n`); }
function section(name: string) {
    console.log(`\n${"═".repeat(70)}\n  ${name}\n${"═".repeat(70)}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════════
// PART 1: ENDPOINT HEALTH (gas-free)
// ════════════════════════════════════════════════════════════════════════════

const META_QUERY = gql`{ _meta { block { number } hasIndexingErrors } }`;

async function testEndpointHealth() {
    section("SUBGRAPH HEALTH");

    const { data } = await apollo.query<{
        _meta: { block: { number: number }; hasIndexingErrors: boolean };
    }>({ query: META_QUERY, fetchPolicy: "network-only" });

    assert.ok(data?._meta, "endpoint must answer _meta");
    assert.equal(data._meta.hasIndexingErrors, false, "subgraph has indexing errors!");
    log(`Indexed head: block ${data._meta.block.number}, no indexing errors`);

    assert.ok(
        BigInt(data._meta.block.number) >= DEPLOY_START_BLOCK,
        `indexed head ${data._meta.block.number} is before startBlock ${DEPLOY_START_BLOCK}`,
    );

    const chainHead = await publicClient.getBlockNumber();
    const lag = chainHead - BigInt(data._meta.block.number);
    log(`Chain head: ${chainHead} → lag ${lag} blocks (~${Number(lag) * 2}s)`);
    if (lag > 300n) {
        console.log(`  ⚠️  Subgraph is ${lag} blocks behind (> ~10 min) — indexing may be stalled`);
    }

    pass("Endpoint reachable, healthy, indexed past deployment block");
}

// ════════════════════════════════════════════════════════════════════════════
// PART 2: SDK QUERIES + ON-CHAIN CROSS-CHECK (gas-free)
// ════════════════════════════════════════════════════════════════════════════

async function testSdkQueriesAgainstChain(): Promise<boolean> {
    section("SDK QUERIES vs ON-CHAIN (latest escrow)");

    // Fresh deployments have no escrows yet — nothing to compare. The live
    // ingestion test (RUN_LIVE=1) creates the first one; rerun afterwards.
    const nextId = await sdk.getNextEscrowId();
    if (nextId === 0n) {
        log("No escrow exists on-chain yet (nextEscrowId=0) — comparison deferred.");
        console.log("  ⏭️  SDK-query cross-check skipped (empty contract; run RUN_LIVE=1 first)\n");
        return false;
    }
    const escrowId = nextId - 1n; // latest existing escrow

    // Exercises ESCROW_DETAIL_QUERY incl. every v2 field — any schema/query
    // name drift makes this throw a GraphQL validation error.
    const indexed = await sdk.getEscrowDetail(escrowId);
    assert.ok(indexed, `escrow #${escrowId} must be indexed`);

    const onChain = await sdk.getEscrowByIdParsed(escrowId, true);

    assert.equal(indexed!.amount, onChain.amount.toString(), "amount mismatch");
    assert.equal(indexed!.buyer.toLowerCase(), onChain.buyer.toLowerCase(), "buyer mismatch");
    assert.equal(indexed!.seller.toLowerCase(), onChain.seller.toLowerCase(), "seller mismatch");
    assert.equal(indexed!.arbiter.toLowerCase(), onChain.arbiter.toLowerCase(), "arbiter mismatch");
    assert.equal(indexed!.wallet.toLowerCase(), onChain.wallet.toLowerCase(), "wallet mismatch");
    assert.equal(indexed!.state, STATE_NAMES[onChain.state], "state mismatch");
    log(`Core fields match on-chain (state ${indexed!.state}, amount ${indexed!.amount})`);

    // The new v2 fields — the whole point of the migration. Outcomes are only
    // set once the matching signature exists on-chain, so assert presence-
    // consistency instead of hard-coded values (works for any escrow state).
    assert.equal(indexed!.arbiterFeeBps, onChain.arbiterFeeBps, "arbiterFeeBps mismatch");
    assert.equal(indexed!.maturityDuration, onChain.maturityDuration.toString(), "maturityDuration mismatch");
    const outcomePairs: Array<[string, `0x${string}`, number | null | undefined]> = [
        ["seller", onChain.sellerWalletSig, indexed!.sellerWalletSigOutcome],
        ["buyer", onChain.buyerWalletSig, indexed!.buyerWalletSigOutcome],
        ["arbiter", onChain.arbiterWalletSig, indexed!.arbiterWalletSigOutcome],
    ];
    for (const [who, sig, outcome] of outcomePairs) {
        const hasSig = !!sig && sig !== "0x";
        if (hasSig) {
            assert.ok(
                outcome === EscrowState.COMPLETE || outcome === EscrowState.REFUNDED || outcome === EscrowState.CANCELED,
                `${who} sig exists on-chain but indexed outcome is ${outcome}`,
            );
        } else {
            assert.equal(outcome ?? null, null, `${who} has no sig on-chain but indexed outcome is ${outcome}`);
        }
    }
    log(`v2 fields match: arbiterFeeBps=${indexed!.arbiterFeeBps}, maturityDuration=${indexed!.maturityDuration}, outcomes=[${outcomePairs.map(([w, , o]) => `${w}:${o ?? "-"}`).join(", ")}]`);

    // List query must include the indexed escrow
    const all = await sdk.getEscrows();
    assert.ok(all.some((e) => e.id === escrowId.toString()), `getEscrows() must contain escrow #${escrowId}`);
    log(`getEscrows(): ${all.length} escrow(s) listed`);

    pass("SDK subgraph queries consistent with on-chain state");
    return true;
}

// ════════════════════════════════════════════════════════════════════════════
// PART 3: LIVE INGESTION (RUN_LIVE=1, costs seller gas)
// ════════════════════════════════════════════════════════════════════════════

async function testLiveIngestion() {
    section("LIVE INGESTION (create escrow → wait for index)");

    if (!sellerWalletClient) throw new Error("SELLER_PRIVATE_KEY required for RUN_LIVE");
    if (!buyerWalletClient) throw new Error("BUYER_PRIVATE_KEY required for RUN_LIVE (buyer address)");
    if (!USDT) throw new Error("SEPOLIA_USDT required for RUN_LIVE");

    const { escrowId } = await sdk.createEscrow(sellerWalletClient, {
        token: USDT,
        buyer: buyerWalletClient.account.address,
        amount: 10_000_000n, // 10 USDT (contract minimum); no transfer happens at create
        maturityTimeDays: 7n,
        title: `Subgraph live test ${Date.now()}`,
    });
    log(`Created escrow #${escrowId} on Sepolia — polling subgraph…`);

    const timeoutMs = 180_000;
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const indexed = await sdk.getEscrowDetail(escrowId);
        if (indexed) {
            const waited = Math.round((Date.now() - started) / 1000);
            log(`Indexed after ~${waited}s`);
            assert.equal(indexed.state, "AWAITING_PAYMENT");
            assert.equal(indexed.sellerWalletSigOutcome, EscrowState.COMPLETE, "outcome-bound seller sig missing");
            assert.equal(indexed.arbiterFeeBps, 0, "no-arbiter escrow must have fee 0");
            assert.equal(indexed.maturityDuration, (7n * 86400n).toString(), "maturityDuration mismatch");
            pass(`Live ingestion works (escrow #${escrowId} indexed with v2 fields)`);
            return;
        }
        await sleep(5000);
    }
    throw new Error(`escrow #${escrowId} not indexed within ${timeoutMs / 1000}s — event ingestion broken?`);
}

// ════════════════════════════════════════════════════════════════════════════
// RUNNER
// ════════════════════════════════════════════════════════════════════════════

async function main() {
    console.log(`\nPalindromePay SDK v3 — Goldsky subgraph test`);
    console.log(`Subgraph: ${subgraphUrl}`);
    console.log(`RPC:      ${rpcUrl}`);

    await testEndpointHealth();
    await testSdkQueriesAgainstChain();

    if (runLive) {
        await testLiveIngestion();
    } else {
        console.log("\n  ℹ️  RUN_LIVE=1 not set — skipping live ingestion test.\n");
    }

    console.log("  🎉 ALL SUBGRAPH TESTS PASSED\n");
    process.exit(0);
}

main().catch((err) => {
    console.error("\n  ❌ SUBGRAPH TEST FAILED\n");
    console.error(err);
    process.exit(1);
});
