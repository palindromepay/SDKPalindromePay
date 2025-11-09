import 'dotenv/config';
import {
    createPublicClient,
    createWalletClient,
    http,
    encodeFunctionData,
    decodeAbiParameters,
    WalletClient,
    Hex,
    Address,
} from 'viem';
import { bscTestnet, idchain } from 'viem/chains';
import { ApolloClient, HttpLink, InMemoryCache } from '@apollo/client/core';
import { privateKeyToAccount } from 'viem/accounts';
import { PalindromeEscrowSDK, CreateEscrowParams, Role } from '../src/PalindromeEscrowSDK';
import { loadErrorMessages, loadDevMessages } from '@apollo/client/dev';
import gql from 'graphql-tag';
// ========== ENV VARIABLES ==========
const contractAddress = process.env.CONTRACT_ADDRESS as `0x${string}`;
const subgraphUrl = process.env.SUBGRAPH_URL as string;
const buyerKey = process.env.BUYER_PRIVATE_KEY as `0x${string}`;
const sellerKey = process.env.SELLER_PRIVATE_KEY as `0x${string}`;
const USDT = process.env.USDT as `0x${string}`;
// Optionally configurable for easy multi-chain testing
const chain = bscTestnet;

if (!contractAddress || !subgraphUrl || !buyerKey || !sellerKey || !USDT) {
    throw new Error("Missing environment variables!");
}
if (process.env.NODE_ENV !== "production") {
    loadDevMessages();
    loadErrorMessages();
}

// ========== ACCOUNTS & WALLET CLIENTS ==========
const buyerAccount = privateKeyToAccount(buyerKey);
const sellerAccount = privateKeyToAccount(sellerKey);

const buyerWalletClient = createWalletClient({
    chain,
    account: buyerAccount,
    transport: http(),
});
const sellerWalletClient = createWalletClient({
    chain,
    account: sellerAccount,
    transport: http(),
});


const publicClient = createPublicClient({
    chain,
    transport: http('https://data-seed-prebsc-1-s1.bnbchain.org:8545'),
});

const apollo = new ApolloClient({
    link: new HttpLink({ uri: subgraphUrl }),
    cache: new InMemoryCache(),
});

// ========== SDK INSTANCE WITH BOTH CLIENTS ==========
const sdk = new PalindromeEscrowSDK({
    contractAddress,
    publicClient,
    buyerWalletClient,
    sellerWalletClient,
    apollo,
    chain,
});

// ========== ESCROW WORKFLOW FUNCTIONS ==========

// Seller creates escrow (typed params, matches improved SDK signature)
async function createEscrow(maturityTimeDays: bigint) {
    const amount = BigInt("1000000"); // 1 USDT
    const params: CreateEscrowParams = {
        token: USDT,
        buyer: buyerWalletClient.account!.address,
        amount,
        maturityTimeDays,
        title: "Test Title",
        ipfsHash: "Qm..."
    };
    try {
        const id = await sdk.createEscrow(sellerWalletClient, params);
        return id;
    } catch (err: any) {
        console.log(err);
    }
}

async function testDepositEscrow(escrowId: bigint) {
    const amount = BigInt("1000000"); // 1 USDT (6 decimals)

    // Step 0: Check if buyer has enough USDT, if not, transfer from owner
    const buyerBalance = await sdk.getUSDTBalanceOf(buyerWalletClient.account.address, USDT);
    console.log("Buyer USDT balance before:", buyerBalance);

    if (BigInt(buyerBalance) < amount) {
        console.log("⚠️ Buyer doesn't have enough USDT. Transferring from owner...");

        // Transfer USDT from owner to buyer
        const transferData = encodeFunctionData({
            abi: sdk.abiUSDT, // Your USDT ABI
            functionName: "transfer",
            args: [buyerWalletClient.account.address, amount]
        });

        const transferTxHash = await sellerWalletClient.sendTransaction({
            to: USDT,
            data: transferData,
            account: sellerWalletClient.account,
            chain: bscTestnet // or your chain
        });

        console.log("Transfer tx sent:", transferTxHash);
        await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
        console.log("✅ USDT transferred to buyer");

        // Verify new balance
        const newBuyerBalance = await sdk.getUSDTBalanceOf(buyerWalletClient.account.address, USDT);
        console.log("Buyer USDT balance after transfer:", newBuyerBalance);

        if (BigInt(newBuyerBalance) < amount) {
            throw new Error("Transfer failed: Buyer still doesn't have enough USDT");
        }
    }

    // Step 1: Deposit into escrow
    try {
        const txHash = await sdk.deposit(buyerWalletClient, escrowId);
        console.log("Deposit tx sent:", txHash);

        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("✅ Deposit confirmed:", receipt.status);

        const escrowBalance = await sdk.getEscrowUSDTBalanceFormatted(USDT);
        console.log("Escrow contract USDT balance:", escrowBalance);
    } catch (err: any) {
        console.error("❌ Deposit error:", err?.message || err);
    }
}

// Buyer confirms delivery
async function testConfirmDelivery(escrowId: bigint) {
    try {
        const txHash = await sdk.confirmDelivery(buyerWalletClient, escrowId);
        console.log("ConfirmDelivery tx:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("ConfirmDelivery confirmed:", receipt);
    } catch (err: any) {
        console.error("ConfirmDelivery error:", err?.message || err);
    }
}

// Off-chain signature + on-chain confirmDeliverySigned
async function testConfirmDeliverySigned(walletClient: WalletClient, escrowId: bigint) {
    try {
        // Can be submitted by seller or any wallet
        const txHash = await sdk.confirmDeliverySigned(walletClient, escrowId);
        console.log("confirmDeliverySigned tx:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("confirmDeliverySigned confirmed:", receipt);
    } catch (err: any) {
        console.error("confirmDeliverySigned error:", err?.message || err);
    }
}

/** 
Condition                                                     |  Function       |  Who Gets Funds
--------------------------------------------------------------+-----------------+----------------
Buyer requested cancel; seller did not; cancelTimeout passed  | cancelByTimeout | Buyer         
No cancel requests; autoReleaseDuration passed                | autoRelease     | Seller        
Both requested cancel                                         | requestCancel   | Buyer (mutual)
Open dispute if buyer cancel, seller not cancel OR            | startDispute    | Arbiter Decide 
seller not deliver after deposit                              |                 |
 
*/


async function testAutoRelease(walletClient: WalletClient, escrowId: bigint) {
    try {
        const txHash = await sdk.autoRelease(walletClient, escrowId);
        console.log("autoRelease tx hash:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("autoRelease transaction confirmed:", receipt);
    } catch (err: any) {
        console.error("Error during autoRelease:", err?.message || err);
    }
}

async function testRequestCancel(walletClient: WalletClient, escrowId: bigint) {
    try {
        const txHash = await sdk.requestCancel(walletClient, escrowId);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("requestCancel transaction confirmed:", receipt?.status);
    } catch (err: any) {
        console.error("Error during requestCancel:", err?.message || err);
    }
}

async function testCancelByTimeout(walletClient: WalletClient, escrowId: bigint) {
    try {
        const txHash = await sdk.cancelByTimeout(walletClient, escrowId);
        console.log("cancelByTimeout tx hash:", txHash);
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log("cancelByTimeout transaction confirmed:", receipt);
    } catch (err: any) {
        console.error("Error during cancelByTimeout:", err?.message || err);
    }
}

async function getUsdtBalance(address: string, usdtToken: `0x${string}`): Promise<bigint> {
    const data = encodeFunctionData({
        abi: sdk.abiUSDT,
        functionName: "balanceOf",
        args: [address],
    });
    const result = await publicClient.call({ to: usdtToken, data });
    const [balance] = decodeAbiParameters([{ type: "uint256" }], result.data as `0x${string}`);
    return BigInt(balance);
}

export interface EscrowDeal {
    amount: bigint;
    state: number;
    buyer: string;
    seller: string;
    token: string;
}

async function printEscrowDealBalance(escrowId: bigint) {
    const deal = await sdk.getEscrowById(escrowId) as any[];
    if (!deal || deal[4] === undefined || deal[4] === null) {
        throw new Error(`Escrow ${escrowId} missing amount property`);
    }
    const decimals = await sdk.getTokenDecimals(USDT);
    const amountBigInt = BigInt(deal[4]);
    const divisor = 10n ** BigInt(decimals);
    const integerPart = amountBigInt / divisor;
    const fractionalPart = amountBigInt % divisor;
    const fractionalStr = fractionalPart.toString().padStart(decimals, "0");
    const formatted = `${integerPart.toString()}.${fractionalStr}`;
    console.log(`USDT held in escrow #${escrowId}:`, formatted);
}



// The same query used by your SDK
export const ALL_ESCROWS_QUERY = gql`
  query AllEscrows {
    escrows {
      id
      txUrl
      token
      buyer
      seller
      arbiter
      amount
      depositTime
      state
      title
      ipfsHash
      createdAt
      updatedAt
      buyerCancelRequested
      sellerCancelRequested
    }
  }
`;


/** --- TEST 1: Full Dispute Flow with Evidence Submission --- */
// async function testDisputeFlowWithEvidence() {
//     console.log("\n🧪 TEST 1: Full Dispute Flow with Evidence Submission\n");

//     // 1. Create escrow
//     const result = await createEscrow(14n);
//     if (!result?.escrowId) {
//         throw new Error("createEscrow did not return an escrowId!");
//     }
//     const escrowId = result.escrowId;

//     // 2. Deposit
//     await testDepositEscrow(escrowId);
//     let status = await sdk.getEscrowStatus(escrowId);
//     console.assert(status.stateName === 'AWAITING_DELIVERY', 'Should be AWAITING_DELIVERY after deposit');

//     // 3. Start dispute
//     console.log("\n--- Starting Dispute ---");
//     const disputeTx = await sdk.startDispute(buyerWalletClient, escrowId);
//     console.log("✅ Dispute started:", disputeTx);

//     status = await sdk.getEscrowStatus(escrowId);
//     console.assert(status.stateName === 'DISPUTED', 'Should be DISPUTED after startDispute');

//     // 4. Check initial submission status
//     console.log("\n--- Checking Initial Submission Status ---");
//     let submissionStatus = await sdk.getDisputeSubmissionStatus(escrowId);
//     console.log("Submission status:", submissionStatus);
//     console.assert(!submissionStatus.buyer, 'Buyer should not have submitted yet');
//     console.assert(!submissionStatus.seller, 'Seller should not have submitted yet');
//     console.assert(!submissionStatus.arbiter, 'Arbiter should not have submitted yet');

//     // 5. Buyer submits evidence
//     console.log("\n--- Buyer Submitting Evidence ---");
//     const buyerIpfsHash = "QmBuyerEvidence123abc";
//     const buyerSubmitTx = await sdk.submitDisputeMessage(
//         buyerWalletClient,
//         escrowId,
//         Role.Buyer,
//         buyerIpfsHash
//     );
//     console.log("✅ Buyer submitted evidence:", buyerSubmitTx);
//     await publicClient.waitForTransactionReceipt({ hash: buyerSubmitTx });

//     // Check buyer submitted
//     const buyerSubmitted = await sdk.hasSubmittedEvidence(escrowId, Role.Buyer);
//     console.assert(buyerSubmitted, 'Buyer should have submitted');

//     // 6. Seller submits evidence
//     console.log("\n--- Seller Submitting Evidence ---");
//     const sellerIpfsHash = "QmSellerEvidence456def";
//     const sellerSubmitTx = await sdk.submitDisputeMessage(
//         sellerWalletClient,
//         escrowId,
//         Role.Seller,
//         sellerIpfsHash
//     );
//     console.log("✅ Seller submitted evidence:", sellerSubmitTx);
//     await publicClient.waitForTransactionReceipt({ hash: sellerSubmitTx });

//     // 7. Arbiter submits review
//     console.log("\n--- Arbiter Submitting Review ---");
//     const arbiterIpfsHash = "QmArbiterDecision789ghi";
//     const arbiterSubmitTx = await sdk.submitDisputeMessage(
//         sellerWalletClient, // Owner is arbiter
//         escrowId,
//         Role.Arbiter,
//         arbiterIpfsHash
//     );
//     console.log("✅ Arbiter submitted review:", arbiterSubmitTx);
//     await publicClient.waitForTransactionReceipt({ hash: arbiterSubmitTx });

//     // 8. Check all submitted
//     submissionStatus = await sdk.getDisputeSubmissionStatus(escrowId);
//     console.log("\n--- Final Submission Status ---");
//     console.log("Submission status:", submissionStatus);
//     console.assert(submissionStatus.buyer, 'Buyer should have submitted');
//     console.assert(submissionStatus.seller, 'Seller should have submitted');
//     console.assert(submissionStatus.arbiter, 'Arbiter should have submitted');
//     console.assert(submissionStatus.allSubmitted, 'All should have submitted');

//     // 9. Resolve dispute
//     console.log("\n--- Resolving Dispute (Complete = seller wins) ---");
//     const resolveTx = await sdk.resolveDispute(
//         sellerWalletClient,
//         escrowId,
//         3 // DisputeResolution.Complete
//     );
//     console.log("✅ Dispute resolved:", resolveTx);
//     await publicClient.waitForTransactionReceipt({ hash: resolveTx });

//     status = await sdk.getEscrowStatus(escrowId);
//     console.assert(status.stateName === 'COMPLETE', 'Should be COMPLETE after resolution');

//     console.log("\n✅ TEST 1 PASSED: Full dispute flow with evidence submission\n");
// }

// /** --- TEST 2: Prevent Double Submission --- */
// async function testPreventDoubleSubmission() {
//     console.log("\n🧪 TEST 2: Prevent Double Submission\n");

//     // 1. Setup escrow in disputed state
//     const result = await createEscrow(14n);
//     if (!result?.escrowId) throw new Error("createEscrow failed");
//     const escrowId = result.escrowId;

//     await testDepositEscrow(escrowId);
//     await sdk.startDispute(buyerWalletClient, escrowId);
//     console.log("✅ Dispute started");

//     // 2. Buyer submits evidence
//     const buyerIpfsHash = "QmBuyerEvidence999";
//     await sdk.submitDisputeMessage(
//         buyerWalletClient,
//         escrowId,
//         Role.Buyer,
//         buyerIpfsHash
//     );
//     console.log("✅ Buyer submitted evidence first time");

//     // 3. Try to submit again (should fail)
//     console.log("\n--- Attempting Double Submission ---");
//     try {
//         await sdk.submitDisputeMessage(
//             buyerWalletClient,
//             escrowId,
//             Role.Buyer,
//             "QmBuyerEvidence2ndAttempt"
//         );
//         console.error("❌ TEST FAILED: Double submission should have been prevented!");
//         throw new Error("Double submission was not prevented");
//     } catch (err: any) {
//         if (err.message.includes("already submitted")) {
//             console.log("✅ Correctly prevented double submission:", err.message);
//         } else {
//             throw err;
//         }
//     }

//     console.log("\n✅ TEST 2 PASSED: Double submission prevented\n");
// }

// /** --- TEST 3: Wrong State Error --- */
// async function testWrongStateError() {
//     console.log("\n🧪 TEST 3: Wrong State Error (Not in Dispute)\n");

//     // 1. Create escrow but don't start dispute
//     const result = await createEscrow(14n);
//     if (!result?.escrowId) throw new Error("createEscrow failed");
//     const escrowId = result.escrowId;

//     await testDepositEscrow(escrowId);

//     const status = await sdk.getEscrowStatus(escrowId);
//     console.log("Current state:", status.stateName); // AWAITING_DELIVERY

//     // 2. Try to submit evidence without dispute (should fail)
//     console.log("\n--- Attempting to Submit Evidence Without Dispute ---");
//     try {
//         await sdk.submitDisputeMessage(
//             buyerWalletClient,
//             escrowId,
//             Role.Buyer,
//             "QmShouldFail"
//         );
//         console.error("❌ TEST FAILED: Should not allow submission in non-DISPUTED state!");
//         throw new Error("Submission in wrong state was not prevented");
//     } catch (err: any) {
//         if (err.message.includes("not in DISPUTED state")) {
//             console.log("✅ Correctly rejected submission in wrong state:", err.message);
//         } else {
//             throw err;
//         }
//     }

//     console.log("\n✅ TEST 3 PASSED: Wrong state error handled correctly\n");
// }

// /** --- TEST 4: Invalid Role Error --- */
// async function testInvalidRoleError() {
//     console.log("\n🧪 TEST 4: Invalid Role Error\n");

//     const result = await createEscrow(14n);
//     if (!result?.escrowId) throw new Error("createEscrow failed");
//     const escrowId = result.escrowId;

//     await testDepositEscrow(escrowId);
//     await sdk.startDispute(buyerWalletClient, escrowId);

//     // Try to submit with invalid role (0 = None)
//     console.log("\n--- Attempting to Submit with Invalid Role ---");
//     try {
//         await sdk.submitDisputeMessage(
//             buyerWalletClient,
//             escrowId,
//             0 as any, // Invalid role
//             "QmShouldFail"
//         );
//         console.error("❌ TEST FAILED: Should not allow invalid role!");
//         throw new Error("Invalid role was not rejected");
//     } catch (err: any) {
//         if (err.message.includes("Invalid role")) {
//             console.log("✅ Correctly rejected invalid role:", err.message);
//         } else {
//             throw err;
//         }
//     }

//     console.log("\n✅ TEST 4 PASSED: Invalid role error handled correctly\n");
// }

// /** --- TEST 5: Empty IPFS Hash Error --- */
// async function testEmptyIpfsHashError() {
//     console.log("\n🧪 TEST 5: Empty IPFS Hash Error\n");

//     const result = await createEscrow(14n);
//     if (!result?.escrowId) throw new Error("createEscrow failed");
//     const escrowId = result.escrowId;

//     await testDepositEscrow(escrowId);
//     await sdk.startDispute(buyerWalletClient, escrowId);

//     // Try to submit with empty IPFS hash
//     console.log("\n--- Attempting to Submit with Empty IPFS Hash ---");
//     try {
//         await sdk.submitDisputeMessage(
//             buyerWalletClient,
//             escrowId,
//             Role.Buyer,
//             "" // Empty hash
//         );
//         console.error("❌ TEST FAILED: Should not allow empty IPFS hash!");
//         throw new Error("Empty IPFS hash was not rejected");
//     } catch (err: any) {
//         if (err.message.includes("IPFS hash is required")) {
//             console.log("✅ Correctly rejected empty IPFS hash:", err.message);
//         } else {
//             throw err;
//         }
//     }

//     console.log("\n✅ TEST 5 PASSED: Empty IPFS hash error handled correctly\n");
// }

// /** --- TEST 6: Check Submission Status Helpers --- */
// async function testSubmissionStatusHelpers() {
//     console.log("\n🧪 TEST 6: Submission Status Helper Functions\n");

//     const result = await createEscrow(14n);
//     if (!result?.escrowId) throw new Error("createEscrow failed");
//     const escrowId = result.escrowId;

//     await testDepositEscrow(escrowId);
//     await sdk.startDispute(buyerWalletClient, escrowId);

//     // Check initial status (all false)
//     console.log("\n--- Initial Status (Before Any Submissions) ---");
//     let status = await sdk.getDisputeSubmissionStatus(escrowId);
//     console.log("Status:", status);
//     console.assert(!status.buyer && !status.seller && !status.arbiter && !status.allSubmitted);

//     // Buyer submits
//     await sdk.submitDisputeMessage(buyerWalletClient, escrowId, Role.Buyer, "QmBuyer1");

//     console.log("\n--- After Buyer Submission ---");
//     status = await sdk.getDisputeSubmissionStatus(escrowId);
//     console.log("Status:", status);
//     console.assert(status.buyer && !status.seller && !status.arbiter && !status.allSubmitted);

//     // Check hasSubmittedEvidence
//     const buyerSubmitted = await sdk.hasSubmittedEvidence(escrowId, Role.Buyer);
//     const sellerSubmitted = await sdk.hasSubmittedEvidence(escrowId, Role.Seller);
//     console.assert(buyerSubmitted, 'hasSubmittedEvidence should return true for buyer');
//     console.assert(!sellerSubmitted, 'hasSubmittedEvidence should return false for seller');

//     console.log("\n✅ TEST 6 PASSED: Submission status helpers work correctly\n");
// }


// ========== MAIN RUNNER ==========
async function run() {

    // const escrows = await sdk.getEscrows();
    // console.log(escrows)

    /**
    
    ================================
    
    ESCROW CONTRACT TEST SCENARIOS
    
    ================================
    */


    /**
    ================================
    
    Test 1
    
    ================================
    */
    /**
    
    Happy Path – Complete Escrow
    
    Seller creates escrow.
    
    Buyer deposits funds.
    
    Buyer confirms delivery.
    
    Assert escrow state is COMPLETE, seller received funds.
    
    */


    const tx = await createEscrow(0n);
    console.log(tx?.escrowId)
    if (tx?.escrowId !== undefined) {

        //await testDepositEscrow(tx.escrowId);      // Type is 'bigint' here
        //await testConfirmDelivery(tx.escrowId);    // Type is 'bigint' here
    } else {
        throw new Error("createEscrow did not return an escrowId!");
    }


    /**
    ================================
    
    Test 2
    
    ================================
    */
    /**
    
    Off-chain Signature Delivery
    
    Seller creates escrow.
    
    Buyer deposits funds.
    
    Buyer signs delivery, seller calls confirmDeliverySigned.
    
    Assert escrow state is COMPLETE, seller received funds.
    
    */

    // const result = await createEscrow(0n); // result is { escrowId, txHash }
    // if (result !== undefined) {
    //     const escrowId = result.escrowId; // Extract the bigint
    //     await testDepositEscrow(escrowId);
    //     const res = await testConfirmDeliverySigned(buyerWalletClient, escrowId);
    //     console.log(res);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }


    /**
    ================================
    
    Test 3
    
    ================================
    */
    /**
    
    Auto-Release after Timeout
    
    Seller creates escrow.
    
    Buyer deposits funds.
    
    Simulate time passing.
    
    Any user calls autoRelease after timeout.
    
    Assert escrow state is COMPLETE, seller received funds.
    */


    // const result = await createEscrow(1n);
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId);      // Type is 'bigint' here
    //     await testAutoRelease(sellerWalletClient, result.escrowId);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }


    /**
    ================================
    
    Test 4
    
    ================================
    */
    /**
    
    Mutual Cancel (Refund to Buyer)
    
    Seller creates escrow.
    
    Buyer deposits funds.
    
    Buyer requests cancel.
    
    Seller requests cancel.
    
    Assert escrow state is CANCELED, buyer refunded.
    
    */

    // const result = await createEscrow(0n);
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId);      // Type is 'bigint' here
    //     await testRequestCancel(buyerWalletClient, result.escrowId);
    //     await testRequestCancel(sellerWalletClient, result.escrowId);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }



    /**
    ================================
    
    Test 5
    
    ================================
    */
    /**
    
    Single Cancel & Timeout (Refund to Buyer)
    
    Seller creates escrow.
    
    Buyer deposits funds.
    
    Buyer requests cancel.
    
    Simulate timeout passage.
    
    Any user calls cancelByTimeout.
    
    Assert escrow state is CANCELED, buyer refunded.
    
    */

    // const result = await createEscrow(0n);
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId);      // Type is 'bigint' here
    //     await testRequestCancel(buyerWalletClient, result.escrowId);
    //     await testCancelByTimeout(buyerWalletClient, result.escrowId);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }



    /**
    ================================
    
    Test 6
    
    ================================
    */
    /**
    
    Dispute and Arbiter Awards Seller
    
    Seller creates escrow, buyer deposits.
    
    Dispute is started (either party).
    
    Arbiter resolves with seller win (COMPLETE).
    
    */

    // const result = await createEscrow(0n); // Should be `bigint`
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId); // Accepts `bigint`
    //     const res = await sdk.startDispute(buyerWalletClient, result.escrowId); // Accepts `bigint`
    //     await sdk.resolveDispute(sellerWalletClient, result.escrowId, 3); // Accepts `bigint`
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }
    // const status = await sdk.getEscrowStatus(result.escrowId);




    /**
    ================================
    
    Test 7
    
    ================================
    */
    /**
    
    Dispute and Arbiter Refunds Buyer
    
    Seller creates escrow, buyer deposits.
    
    Dispute started.
    
    Arbiter resolves with REFUNDED (buyer win).
    
    */

    // const result = await createEscrow(1n); // Should be `bigint`
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId); // Accepts `bigint`
    //     const status = await sdk.getEscrowStatus(result.escrowId);
    //     await sdk.startDispute(buyerWalletClient, result.escrowId); // Accepts `bigint`
    //     await sdk.resolveDispute(sellerWalletClient, result.escrowId, 4);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }
    // const status = await sdk.getEscrowStatus(result.escrowId);




    /**
    ================================
    
    Test 8
    
    ================================
    */
    /**
    
    Direct Refund by Arbiter
    
    Seller creates escrow, buyer deposits.
    
    Arbiter calls direct refund for buyer.
    
    */


    // const result = await createEscrow(2n); // Should be `bigint`
    // if (result?.escrowId !== undefined) {
    //     await testDepositEscrow(result.escrowId);
    //     const status = await sdk.getEscrowStatus(result.escrowId);
    //     await sdk.refund(sellerWalletClient, result.escrowId);
    // } else {
    //     throw new Error("createEscrow did not return an escrowId!");
    // }
    // const status = await sdk.getEscrowStatus(result.escrowId);




    /**
     * Check Balances
     */

    // const buyerBalance = await getUsdtBalance(sellerWalletClient.account!.address, USDT);
    // console.log("Buyer actual USDT balance:", buyerBalance.toString());
    // const escrowBalance = await getUsdtBalance(contractAddress, USDT);
    // console.log("Escrow contract's actual USDT balance:", escrowBalance.toString());


    // async function runAllDisputeTests() {
    //     console.log("\n" + "=".repeat(60));
    //     console.log("🧪 RUNNING ALL DISPUTE EVIDENCE TESTS");
    //     console.log("=".repeat(60) + "\n");

    //     try {
    //         // await testDisputeFlowWithEvidence();
    //         // await testPreventDoubleSubmission();
    //         // await testWrongStateError();
    //         // await testInvalidRoleError();
    //         // await testEmptyIpfsHashError();
    //         await testSubmissionStatusHelpers();

    //         console.log("\n" + "=".repeat(60));
    //         console.log("✅ ALL TESTS PASSED!");
    //         console.log("=".repeat(60) + "\n");
    //     } catch (err: any) {
    //         console.error("\n" + "=".repeat(60));
    //         console.error("❌ TEST SUITE FAILED!");
    //         console.error("=".repeat(60));
    //         console.error("\nError:", err.message);
    //         console.error("\nStack:", err.stack);
    //         process.exit(1);
    //     }
    // }

    // Run tests
    // runAllDisputeTests();

}

void run();

