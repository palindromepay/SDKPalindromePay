import {
    Address,
    PublicClient,
    WalletClient,
    Abi,
    Account,
    encodePacked,
    keccak256,
    Hex,
} from "viem";
import PalindromeEscrowWalletABI from "./contract/PalindromeEscrowWallet.json";


export async function signWalletHash(
    signer: WalletClient,
    hash: Hex,
): Promise<Hex> {
    const signature = await signer.signMessage({
        account: signer.account!,
        message: { raw: hash },
    });
    return signature as Hex;
}


export class PalindromeEscrowWalletClient {
    constructor(
        readonly publicClient: PublicClient,
        readonly chainId: number,
    ) { }

    private readonly abi: Abi = PalindromeEscrowWalletABI.abi as Abi;

    buildTransferHash(
        wallet: Address,
        token: Address,
        to: Address,
        amount: bigint,
        nonce: bigint,
    ): Hex {
        return keccak256(
            encodePacked(
                ["address", "address", "address", "uint256", "uint256", "uint256"],
                [wallet, token, to, amount, nonce, BigInt(this.chainId)],
            ),
        );
    }

    buildSplitHash(
        wallet: Address,
        token: Address,
        to: Address,
        netAmount: bigint,
        feeTo: Address,
        feeAmount: bigint,
        nonce: bigint,
    ): Hex {
        return keccak256(
            encodePacked(
                [
                    "address",
                    "address",
                    "address",
                    "uint256",
                    "address",
                    "uint256",
                    "uint256",
                    "uint256",
                ],
                [
                    wallet,
                    token,
                    to,
                    netAmount,
                    feeTo,
                    feeAmount,
                    nonce,
                    BigInt(this.chainId),
                ],
            ),
        );
    }

    async executeERC20(
        executor: WalletClient,
        wallet: Address,
        token: Address,
        to: Address,
        amount: bigint,
        signatures: [Hex, Hex, Hex],
    ): Promise<Hex> {
        const txHash = await executor.writeContract({
            address: wallet,
            abi: this.abi,
            functionName: "executeERC20",
            args: [token, to, amount, signatures],
            account: executor.account as Account,
            chain: executor.chain,
        });

        await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        return txHash;
    }

    async executeERC20Split(
        executor: WalletClient,
        wallet: Address,
        token: Address,
        to: Address,
        netAmount: bigint,
        feeTo: Address,
        feeAmount: bigint,
        signatures: [Hex, Hex, Hex],
    ): Promise<Hex> {
        const txHash = await executor.writeContract({
            address: wallet,
            abi: this.abi,
            functionName: "executeERC20Split",
            args: [token, to, netAmount, feeTo, feeAmount, signatures],
            account: executor.account as Account,
            chain: executor.chain,
        });

        await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        return txHash;
    }
}
