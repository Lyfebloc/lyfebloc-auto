// TS_NODE_PROJECT='tsconfig.testing.json' npx mocha -r ts-node/register test/staLyfePaths.spec.ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();
import { expect } from 'chai';
import cloneDeep from 'lodash.clonedeep';
import {
    PoolDictionary,
    SubgraphPoolBase,
    AutoConfig,
    NewPath,
    PoolFilter,
    SwapOptions,
    SwapTypes,
} from '../src';
import {
    getPathsUsingStaBalPool,
    createPath,
    getHighestLiquidityPool,
    parseToPoolsDict,
    getBoostedPaths,
} from '../src/routeProposal/filtering';
import staLyfePools from './testData/staLyfe/staLyfePools.json';
import { checkPath, poolsCheckPath } from './lib/testHelpers';
import {
    LYFE,
    TUSD,
    MKR,
    autoConfigTestStaBal,
    autoConfigEth,
} from './lib/constants';
import { BigNumber } from '@ethersproject/bignumber';
import { RouteProposer } from '../src/routeProposal';

describe(`staLyfePaths.`, () => {
    it(`should be no USDC connecting pool for mainnet`, () => {
        const tokenIn = TUSD.address;
        const tokenOut = LYFE.address;
        const correctPoolIds = [];

        itCreatesCorrectPath(
            tokenIn,
            tokenOut,
            cloneDeep(staLyfePools.pools),
            correctPoolIds,
            autoConfigEth
        );
    });

    context('when both tokens are paired with staLYFE', () => {
        const tokenIn = '0x0000000000000000000000000000000000000002';
        const tokenOut = TUSD.address;
        it('returns an empty array', () => {
            // We expect no staLyfePaths as the path already exists as multihop
            const correctPoolIds = [];

            itCreatesCorrectPath(
                tokenIn,
                tokenOut,
                cloneDeep(staLyfePools.pools),
                correctPoolIds
            );

            const [pathData] = getPaths(
                tokenIn,
                tokenOut,
                SwapTypes.SwapExactIn,
                cloneDeep(staLyfePools.pools),
                10,
                autoConfigTestStaBal
            );
            expect(pathData.length).to.eq(1);
            poolsCheckPath(pathData[0], ['staLyfePair2', 'staLyfePair1']);
        });
    });

    context('when neither token is paired with staLYFE', () => {
        const tokenIn = '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270';
        const tokenOut = '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619';
        it('returns an empty array', () => {
            const correctPoolIds = [];

            itCreatesCorrectPath(
                tokenIn,
                tokenOut,
                cloneDeep(staLyfePools.pools),
                correctPoolIds
            );
        });
    });

    context('when tokenIn is paired with staLYFE', () => {
        const tokenIn = TUSD.address;
        context('when tokenOut is paired with USDC', () => {
            const tokenOut = LYFE.address;
            it('returns the expected route', () => {
                // i.e. TUSD>[staLyfePair1]>staLYFE>[usdcConnecting]>USDC>[balPool]>LYFE
                const correctPoolIds = [
                    'staLyfePair1',
                    'usdcConnecting',
                    'balPool',
                ];

                itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    correctPoolIds
                );
            });

            it('should use the most liquid tokenOut-USDC pool', () => {
                const poolsAll = itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    ['staLyfePair1', 'usdcConnecting', 'balPool']
                );

                // Hop out as it is USDC > tokenOut
                const mostLiquidPool = getHighestLiquidityPool(
                    autoConfigTestStaBal.usdcConnectingPool.usdc,
                    tokenOut,
                    poolsAll
                );

                expect(mostLiquidPool).to.eq('balPool');
            });

            it(`should create a valid multihop path`, () => {
                const poolsAll = itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    ['staLyfePair1', 'usdcConnecting', 'balPool']
                );

                const staLyfePoolIdIn = 'staLyfePair1';
                const staLyfePoolIn = poolsAll[staLyfePoolIdIn];
                const hopTokenStaBal = autoConfigTestStaBal.staLyfe3Pool.address;
                const usdcConnectingPool =
                    poolsAll[autoConfigTestStaBal.usdcConnectingPool.id];

                const multihopPath = createPath(
                    [
                        tokenIn,
                        hopTokenStaBal,
                        autoConfigTestStaBal.usdcConnectingPool.usdc,
                    ],
                    [staLyfePoolIn, usdcConnectingPool]
                );

                checkPath(
                    ['staLyfePair1', 'usdcConnecting'],
                    poolsAll,
                    multihopPath,
                    tokenIn,
                    autoConfigTestStaBal.usdcConnectingPool.usdc
                );
            });
        });

        context('when tokenOut is not paired with USDC', () => {
            const tokenOut = MKR.address;
            it(`returns an empty array`, () => {
                const correctPoolIds = [];

                itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    correctPoolIds
                );
            });
        });
    });

    context('when tokenOut is paired with staLYFE', () => {
        const tokenOut = TUSD.address;
        context('when tokenIn is paired with USDC', () => {
            const tokenIn = LYFE.address;

            it('returns the expected route', () => {
                // i.e. LYFE>[balPool]>USDC>[usdcConnecting]>staLYFE>[staLyfePair1]>TUSD
                const correctPoolIds = [
                    'balPool',
                    'usdcConnecting',
                    'staLyfePair1',
                ];

                itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    correctPoolIds
                );
            });

            it('should use the most liquid tokenIn-USDC pool', () => {
                const poolsAll = itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    ['balPool', 'usdcConnecting', 'staLyfePair1']
                );

                // Hop in as it is tokenIn > USDC
                const mostLiquidPool = getHighestLiquidityPool(
                    tokenIn,
                    autoConfigTestStaBal.usdcConnectingPool.usdc,
                    poolsAll
                );

                expect(mostLiquidPool).to.eq('balPool');
            });
        });

        context('when tokenIn is not paired with USDC', () => {
            it(`returns an empty array`, () => {
                const tokenIn = MKR.address;
                const tokenOut = TUSD.address;
                const correctPoolIds = [];

                itCreatesCorrectPath(
                    tokenIn,
                    tokenOut,
                    cloneDeep(staLyfePools.pools),
                    correctPoolIds
                );
            });
        });
    });
});

function itCreatesCorrectPath(
    tokenIn: string,
    tokenOut: string,
    pools: SubgraphPoolBase[],
    expectedPoolIds: string[],
    config: AutoConfig = autoConfigTestStaBal
): PoolDictionary {
    const poolsAll = parseToPoolsDict(pools, 0);

    const paths = getPathsUsingStaBalPool(
        tokenIn,
        tokenOut,
        poolsAll,
        poolsAll,
        config
    );

    if (expectedPoolIds.length === 0) {
        expect(paths.length).to.eq(0);
        return poolsAll;
    }

    expect(paths.length).to.eq(1);
    poolsCheckPath(paths[0], expectedPoolIds);
    return poolsAll;
}

function getPaths(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    pools: SubgraphPoolBase[],
    maxPools: number,
    config: AutoConfig
): [NewPath[], PoolDictionary, NewPath[]] {
    const poolsAll = parseToPoolsDict(cloneDeep(pools), 0);
    const routeProposer = new RouteProposer(config);
    const swapOptions: SwapOptions = {
        gasPrice: BigNumber.from(0),
        swapGas: BigNumber.from(0),
        timestamp: 0,
        maxPools: 10,
        poolTypeFilter: PoolFilter.All,
        forceRefresh: true,
    };

    const paths = routeProposer.getCandidatePaths(
        tokenIn,
        tokenOut,
        swapType,
        pools,
        swapOptions
    );

    const boostedPaths = getBoostedPaths(tokenIn, tokenOut, poolsAll, config);
    return [paths, poolsAll, boostedPaths];
}
