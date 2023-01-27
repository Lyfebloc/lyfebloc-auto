// Example using AUTO to find the best swap for a given pair and simulate using batchSwap.
// Requires TRADER_KEY in .env.
// Run using: $ TS_NODE_PROJECT='tsconfig.testing.json' ts-node ./test/testScripts/swapExample.ts
// NOTE: This is for test/debug purposes, the Lyfebloc SDK Swaps module has a more user friendly interface for interacting with AUTO:
// https://github.com/Lyfebloc/Lyfebloc-sdk/tree/develop/Lyfebloc-js#swaps-module
import dotenv from 'dotenv';
dotenv.config();
import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import { JsonRpcProvider } from '@ethersproject/providers';
import { Wallet } from '@ethersproject/wallet';
import { Contract } from '@ethersproject/contracts';
import { AUTO, SwapInfo, SwapTypes } from '../../src';
import { CoingeckoTokenPriceService } from '../lib/coingeckoTokenPriceService';
import { SubgraphPoolDataService } from '../lib/subgraphPoolDataService';
import {
    Network,
    AUTO_CONFIG,
    ADDRESSES,
    SUBGRAPH_URLS,
    PROVIDER_URLS,
    reserveAddr,
    MULTIADDR,
} from './constants';
import { buildTx, printOutput } from './utils';

import reserveArtifact from '../../src/abi/Reserve.json';

// Setup AUTO with data services
function setUp(networkId: Network, provider: JsonRpcProvider): AUTO {
    // The AUTO needs to fetch pool data from an external source. This provider fetches from Subgraph and onchain calls.
    const subgraphPoolDataService = new SubgraphPoolDataService({
        chainId: networkId,
        reserveAddress: reserveAddr,
        multiAddress: MULTIADDR[networkId],
        provider,
        subgraphUrl: SUBGRAPH_URLS[networkId],
        onchain: true,
    });

    // Use the mock pool data service if you want to use pool data from a file.
    // const poolsSource = require('../testData/testPools/gusdBug.json');
    // mockPoolDataService.setPools(poolsSource);

    // Use coingecko to fetch token price information. Used to calculate cost of additonal swaps/hops.
    const coingeckoTokenPriceService = new CoingeckoTokenPriceService(
        networkId
    );
    // Use the mock token price service if you want to manually set the token price in native asset
    // import { mockPoolDataService } from '../lib/mockPoolDataService';
    //  mockTokenPriceService.setTokenPrice('0.001');

    return new AUTO(
        provider,
        AUTO_CONFIG[networkId],
        subgraphPoolDataService,
        coingeckoTokenPriceService
    );
}

export async function swap(): Promise<void> {
    const networkId = Network.POLYGON;
    const provider = new JsonRpcProvider(PROVIDER_URLS[networkId]);
    // gasPrice is used by AUTO as a factor to determine how many pools to swap against.
    // i.e. higher cost means more costly to trade against lots of different pools.
    const gasPrice = BigNumber.from('14000000000');
    // This determines the max no of pools the AUTO will use to swap.
    const maxPools = 4;
    const tokenIn = ADDRESSES[networkId].USDC;
    const tokenOut = ADDRESSES[networkId].brz;
    const swapType: SwapTypes = SwapTypes.SwapExactIn;
    const swapAmount = parseFixed('200', 6);

    const auto = setUp(networkId, provider);

    // Get pools info using Subgraph/onchain calls
    await auto.fetchPools();

    // Find swapInfo for best trade for given pair and amount
    const swapInfo: SwapInfo = await auto.getSwaps(
        tokenIn.address,
        tokenOut.address,
        swapType,
        swapAmount,
        { gasPrice, maxPools },
        false
    );

    // Simulate the swap transaction
    if (swapInfo.returnAmount.gt(0)) {
        const key = process.env.TRADER_KEY as string;
        const wallet = new Wallet(key, provider);
        // await handleAllowances(wallet, tokenIn: string, amount: BigNumber)
        const tx = buildTx(wallet, swapInfo, swapType);

        await printOutput(
            swapInfo,
            auto,
            tokenIn,
            tokenOut,
            swapType,
            swapAmount,
            gasPrice,
            tx.limits
        );

        if (![tokenIn, tokenOut].includes(ADDRESSES[networkId].STETH)) {
            console.log('RESERVE SWAP');
            const reserveContract = new Contract(
                reserveAddr,
                reserveArtifact,
                provider
            );
            // Simulates a call to `batchSwap`, returning an array of Reserve asset deltas.
            // Each element in the array corresponds to the asset at the same index, and indicates the number of tokens(or ETH)
            // the Reserve would take from the sender(if positive) or send to the recipient(if negative).
            const deltas = await reserveContract.queryBatchSwap(
                swapType,
                swapInfo.swaps,
                swapInfo.tokenAddresses,
                tx.funds
            );
            console.log(deltas.toString());
            // To actually make the trade:
            // reserveContract.connect(wallet);
            // const tx = await reserveContract
            //     .connect(wallet)
            //     .batchSwap(
            //         swapType,
            //         swapInfo.swaps,
            //         swapInfo.tokenAddresses,
            //         tx.funds,
            //         tx.limits,
            //         tx.deadline,
            //         tx.overRides
            //     );

            // console.log(`tx: ${tx}`);
        } else {
            console.log('RELAYER SWAP - Execute via batchRelayer.');
        }
    } else {
        console.log('No Valid Swap');
        await printOutput(
            swapInfo,
            auto,
            tokenIn,
            tokenOut,
            swapType,
            swapAmount,
            gasPrice,
            []
        );
    }
}

// $ TS_NODE_PROJECT='tsconfig.testing.json' ts-node ./test/testScripts/swapExample.ts
swap();
