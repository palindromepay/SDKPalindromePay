import {
    Address,
    PublicClient,
    WalletClient,
    Abi,
    Account,
    Hex,
} from 'viem';
import PalindromeEscrowWalletABI from './contract/PalindromeEscrowWallet.json';

export class PalindromeEscrowWalletClient {
    readonly publicClient: PublicClient;
    readonly chainId: number;
    private readonly abi: Abi = PalindromeEscrowWalletABI.abi as Abi;

    constructor(publicClient: PublicClient, chainId: number) {
        this.publicClient = publicClient;
        this.chainId = chainId;
    }

    // ----- EIP-712 typed data for ExecuteSplit -----

    getExecuteSplitTypedData(params: {
        wallet: Address;
        token: Address;
        to: Address;
        feeTo: Address;
        nonce: bigint;
    }) {
        const { wallet, token, to, feeTo, nonce } = params;

        const domain = {
            name: 'PalindromeEscrowWallet',
            version: '1',
            chainId: this.chainId,
            verifyingContract: wallet,
        } as const;

        const types = {
            ExecuteSplit: [
                { name: 'token', type: 'address' },
                { name: 'to', type: 'address' },
                { name: 'feeTo', type: 'address' },
                { name: 'nonce', type: 'uint256' },
            ],
        } as const;

        const message = {
            token,
            to,
            feeTo,
            nonce,
        };

        return { domain, types, message };
    }

    /**
     * Sign ExecuteSplit typed data for this wallet.
     * Use for buyer/seller/arbiter signatures.
     */
    async signExecuteSplit(
        signer: WalletClient,
        params: {
            wallet: Address;
            token: Address;
            to: Address;
            feeTo: Address;
            nonce: bigint;
        },
    ): Promise<Hex> {
        if (!signer.account) {
            throw new Error('WalletClient must have an account');
        }

        const { domain, types, message } = this.getExecuteSplitTypedData(params);

        const signature = await signer.signTypedData({
            account: signer.account!,
            domain,
            types,
            primaryType: 'ExecuteSplit',
            message,
        });

        return signature as Hex;
    }

    // ----- Execution functions -----

    async executeERC20Split(
        executor: WalletClient,
        wallet: Address,
        to: Address,
        signatures: [Hex, Hex, Hex],
    ): Promise<Hex> {
        if (!executor.account) {
            throw new Error('Executor must have an account');
        }

        const txHash = await executor.writeContract({
            address: wallet,
            abi: this.abi,
            functionName: 'executeERC20Split',
            args: [to, signatures],
            account: executor.account as Account,
            chain: executor.chain,
        });

        await this.publicClient.waitForTransactionReceipt({ hash: txHash });
        return txHash;
    }
}
