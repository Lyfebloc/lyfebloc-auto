// TS_NODE_PROJECT='tsconfig.testing.json' npx mocha -r ts-node/register test/linear.spec.ts
import { assert, expect } from 'chai';
import cloneDeep from 'lodash.clonedeep';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber, parseFixed } from '@ethersproject/bignumber';
import { BigNumber as OldBigNumber, bnum } from '../src/utils/bignumber';
import {
    PoolDictionary,
    NewPath,
    SwapTypes,
    PoolTypes,
    SubgraphPoolBase,
    AutoConfig,
    SwapOptions,
    PoolFilter,
} from '../src';
import {
    parseToPoolsDict,
    getBoostedPaths,
} from '../src/routeProposal/filtering';
import { LinearPool, PairTypes } from '../src/pools/linearPool/linearPool';
import { checkPath, getFullSwap, getTotalSwapAmount } from './lib/testHelpers';
import {
    DAI,
    aDAI,
    lDAI,
    USDC,
    lUSDC,
    LYFE,
    bbaUSD,
    TestToken,
    MKR,
    GUSD,
    TUSD,
    bTUSD,
    USDT,
    LINEAR_AUSDT,
    LINEAR_ADAI,
    aUSDT,
    KOVAN_LYFE,
    AAVE_USDT,
    autoConfigTest,
    autoConfigKovan,
    autoConfigFullKovan,
} from './lib/constants';

// Single Linear pool DAI/aDAI/lDAI
import singleLinear from './testData/linearPools/singleLinear.json';
// weightedWeth/StaBal3Id, weightedBal/Weth, weightedUsdc/Weth, weightedDai/Weth, weightedDai/Usdc, linearUSDC, linearDAI, linearUSDT, staLyfe3Id, staLyfe3/Gusd, weightedMkr/Dai
import smallLinear from './testData/linearPools/smallLinear.json';
import kovanPools from './testData/linearPools/kovan.json';
import fullKovanPools from './testData/linearPools/fullKovan.json';
import { checkBestPath } from './boostedPaths.spec';
import { RouteProposer } from '../src/routeProposal';

describe('linear pool tests', () => {
    context('parsePoolPairData', () => {
        it(`should correctly parse token > phantomLbpt`, async () => {
            const tokenIn = DAI;
            const tokenOut = lDAI;
            const poolSG = cloneDeep(singleLinear).pools[0];
            testParsePool(poolSG, tokenIn, tokenOut, PairTypes.MainTokenToLbpt);
        });

        it(`should correctly parse phantomLbpt > token`, async () => {
            const tokenIn = lUSDC;
            const tokenOut = USDC;
            const poolSG = cloneDeep(smallLinear).pools[4];
            testParsePool(poolSG, tokenIn, tokenOut, PairTypes.LbptToMainToken);
        });

        it(`should correctly parse token > token`, async () => {
            const tokenIn = DAI;
            const tokenOut = aDAI;
            const poolSG = cloneDeep(singleLinear).pools[0];
            testParsePool(
                poolSG,
                tokenIn,
                tokenOut,
                PairTypes.MainTokenToWrappedToken
            );
        });

        it(`should correctly parse wrappedToken > phantomLbpt`, async () => {
            const tokenIn = aDAI;
            const tokenOut = lDAI;
            const poolSG = cloneDeep(singleLinear).pools[0];
            testParsePool(
                poolSG,
                tokenIn,
                tokenOut,
                PairTypes.WrappedTokenToLbpt
            );
        });

        it(`should correctly parse phantomLbpt > wrappedToken`, async () => {
            const tokenIn = lDAI;
            const tokenOut = aDAI;
            const poolSG = cloneDeep(singleLinear).pools[0];
            testParsePool(
                poolSG,
                tokenIn,
                tokenOut,
                PairTypes.LbptToWrappedToken
            );
        });
    });

    context('limit amounts', () => {
        it(`getLimitAmountSwap, token to token should return 0`, async () => {
            const tokenIn = DAI.address;
            const tokenOut = aDAI.address;
            const poolSG = cloneDeep(singleLinear);
            const pool = LinearPool.fromPool(poolSG.pools[0]);
            const poolPairData = pool.parsePoolPairData(tokenIn, tokenOut);

            let amount = pool.getLimitAmountSwap(
                poolPairData,
                SwapTypes.SwapExactIn
            );

            expect(amount.toString()).to.eq('1485000000.122222221232222221');

            amount = pool.getLimitAmountSwap(
                poolPairData,
                SwapTypes.SwapExactOut
            );

            expect(amount.toString()).to.eq('1485000000.122222221232222221');
        });

        it(`getLimitAmountSwap, SwapExactIn, TokenToLbpt should return valid limit`, async () => {
            const tokenIn = DAI.address;
            const tokenOut = lDAI.address;
            const swapType = SwapTypes.SwapExactIn;
            const pools = singleLinear.pools;
            const poolIndex = 0;

            testLimit(
                tokenIn,
                tokenOut,
                swapType,
                pools,
                poolIndex,
                bnum('8138925365362304138472.897010550433213647')
            );
        });

        it(`getLimitAmountSwap, SwapExactIn, LbptToToken should return valid limit`, async () => {
            testLimit(
                lDAI.address,
                DAI.address,
                SwapTypes.SwapExactIn,
                singleLinear.pools,
                0,
                bnum('937.89473235457065896')
            );
        });

        it(`getLimitAmountSwap, SwapExactOut, TokenToLbpt should return valid limit`, async () => {
            const tokenIn = DAI.address;
            const tokenOut = lDAI.address;
            const tokenOutDecimals = lDAI.decimals;
            const swapType = SwapTypes.SwapExactOut;
            const pools = singleLinear.pools;
            const poolIndex = 0;

            const MAX_RATIO = bnum(10);

            const expectedAmt = bnum(pools[poolIndex].tokens[2].balance)
                .times(MAX_RATIO)
                .dp(tokenOutDecimals);

            testLimit(
                tokenIn,
                tokenOut,
                swapType,
                pools,
                poolIndex,
                expectedAmt
            );
        });

        it(`getLimitAmountSwap, SwapExactOut, LbptToToken should return valid limit`, async () => {
            testLimit(
                lDAI.address,
                DAI.address,
                SwapTypes.SwapExactOut,
                singleLinear.pools,
                0,
                bnum('1485000000.122222221232222221')
            );
        });
    });

    context('Considering Linear Paths Only', () => {
        context('Using Single Linear Pool', () => {
            const config = {
                chainId: 99,
                weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                connectingTokens: [
                    {
                        symbol: 'weth',
                        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
                    },
                ],
                reserve: '0xeefba1e63905ef1d7acba5a8513c70307c1ce441',
            };
            it('getPathsUsingLinearPool return empty paths', () => {
                const tokenIn = DAI.address;
                const tokenOut = USDC.address;
                const maxPools = 4;
                const [, , boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    singleLinear.pools,
                    maxPools,
                    config
                );
                expect(boostedPaths).to.be.empty;
            });

            it('getPathsUsingLinearPool return empty paths', () => {
                const tokenIn = DAI.address;
                const tokenOut = USDC.address;
                const maxPools = 4;
                const [, , boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    singleLinear.pools,
                    maxPools,
                    config
                );
                expect(boostedPaths).to.be.empty;
            });
        });

        context('Linear pool not part of StaBal3', () => {
            // i.e. Not DAI/USDC/USDT
            it('should have standard single hop path', async () => {
                const tokenIn = TUSD.address;
                const tokenOut = bTUSD.address;
                const maxPools = 4;

                const [allPaths, poolsAllDict, boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                expect(boostedPaths).to.be.empty;
                expect(allPaths.length).to.equal(1);
                checkPath(
                    ['linearTUSD'],
                    poolsAllDict,
                    allPaths[0],
                    tokenIn,
                    tokenOut
                );
            });

            it('should return no paths', async () => {
                const tokenIn = TUSD.address;
                const tokenOut = USDC.address;
                const maxPools = 4;

                const [allPaths, , boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                expect(boostedPaths).to.be.empty;
                expect(allPaths).to.be.empty;
            });
        });

        context('Stable<>Token with no staLyfe or WETH paired pool', () => {
            it('Stable>Token, getBoostedPaths return empty paths', async () => {
                const tokenIn = MKR.address;
                const tokenOut = DAI.address;
                const maxPools = 10;

                const [, , boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                assert.equal(boostedPaths.length, 0);
            });

            it('Token>Stable, getBoostedPaths return empty paths', async () => {
                const tokenIn = USDC.address;
                const tokenOut = MKR.address;
                const maxPools = 10;

                const [, , boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                assert.equal(boostedPaths.length, 0);
            });
        });

        context('getBoostedPaths - stable pair', () => {
            it('should return 3 valid paths', async () => {
                const tokenIn = DAI.address;
                const tokenOut = USDC.address;
                const maxPools = 10;

                const [, poolsAllDict, boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );
                assert.equal(boostedPaths.length, 3);
                const expectedPoolsIdsArray = [
                    ['linearDAI', 'bbaUSD-Pool', 'linearUSDC'],
                    // eslint-disable-next-line prettier/prettier
                    [
                        'linearDAI',
                        'bbaUSD-Pool',
                        'weightedWeth-BBausd',
                        'weightedUsdcWeth',
                    ],
                    // eslint-disable-next-line prettier/prettier
                    [
                        'weightedDaiWeth',
                        'weightedWeth-BBausd',
                        'bbaUSD-Pool',
                        'linearUSDC',
                    ],
                ];
                for (let i = 0; i < 3; i++) {
                    checkPath(
                        expectedPoolsIdsArray[i],
                        poolsAllDict,
                        boostedPaths[i],
                        tokenIn,
                        tokenOut
                    );
                }
            });

            it('tokenIn and tokenOut belong to same linear pool should have standard single hop path', async () => {
                const tokenIn = aDAI.address;
                const tokenOut = DAI.address;
                const maxPools = 10;

                const [allPaths, poolsAllDict, boostedPaths] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );
                assert.equal(boostedPaths.length, 1);
                assert.equal(allPaths.length, 2);
                checkPath(
                    ['linearDAI'],
                    poolsAllDict,
                    allPaths[0],
                    tokenIn,
                    tokenOut
                );
            });
        });
    });

    context('Considering All Paths', () => {
        context('stable pair with weighted and linear pools', () => {
            it('should return 3 paths via weighted and linear pools', async () => {
                const tokenIn = DAI.address;
                const tokenOut = USDC.address;
                const maxPools = 10;

                const [paths, poolAllDict] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );
                // boosted paths for DAI/USDC were tested in a previous case
                assert.equal(paths.length, 5);
                checkPath(
                    ['weightedDaiWeth', 'weightedUsdcWeth'],
                    poolAllDict,
                    paths[3],
                    tokenIn,
                    tokenOut
                );
                checkPath(
                    ['weightedDaiUsdc'],
                    poolAllDict,
                    paths[4],
                    tokenIn,
                    tokenOut
                );
            });
        });

        context('non-stable pair with no staLyfe or WETH paired pool', () => {
            it('should return 1 path via weighted pools', async () => {
                const tokenIn = MKR.address;
                const tokenOut = DAI.address;
                const maxPools = 10;

                const [paths, poolsAllDict] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                assert.equal(paths.length, 1);
                checkPath(
                    ['weightedMkrDai'],
                    poolsAllDict,
                    paths[0],
                    tokenIn,
                    tokenOut
                );
            });
        });

        context('token paired with staLyfe3 LBPT', () => {
            it('should return 1 valid linear paths', async () => {
                const tokenIn = GUSD.address;
                const tokenOut = DAI.address;
                const maxPools = 10;

                const [paths, poolsAllDict] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );

                assert.equal(paths.length, 2);
                // TokenIn>[weightedBalStaBal3]>lDAI>[staLYFE3]>staLyfe3>[linearDAI]>DAI
                checkPath(
                    ['bbaUsdGusd', 'bbaUSD-Pool', 'linearDAI'],
                    poolsAllDict,
                    paths[0],
                    tokenIn,
                    tokenOut
                );
                // The other path id is:
                // bbaUsdGusdweightedWeth-BBausdweightedDaiWeth
            });

            it('should return 1 valid linear paths', async () => {
                const tokenIn = USDC.address;
                const tokenOut = GUSD.address;
                const maxPools = 10;

                const [paths, poolsAllDict] = getPaths(
                    tokenIn,
                    tokenOut,
                    SwapTypes.SwapExactIn,
                    smallLinear.pools,
                    maxPools
                );
                assert.equal(paths.length, 2);
                // TokenIn>[linearUSDC]>lUSDC>[staLYFE3]>staLyfe3>[staLyfe3Gusd]>TokenOut
                checkPath(
                    ['linearUSDC', 'bbaUSD-Pool', 'bbaUsdGusd'],
                    poolsAllDict,
                    paths[0],
                    tokenIn,
                    tokenOut
                );
                // The other path id is:
                // weightedUsdcWethweightedWeth-BBausdbbaUsdGusd
            });
        });
    });

    context('Long paths using linear and WETH-staLYFE3 pool', () => {
        it('should return 2 valid linear paths, USDC>LYFE', async () => {
            const tokenIn = USDC.address;
            const tokenOut = LYFE.address;
            const maxPools = 10;

            const [paths, poolsAllDict] = getPaths(
                tokenIn,
                tokenOut,
                SwapTypes.SwapExactIn,
                smallLinear.pools,
                maxPools
            );
            assert.equal(paths.length, 2);
            // USDC>[linearUSDC]>lUSDC>[staLYFE3]>staLyfe3Lbpt>[staLYFE3Weth]>WETH>[BalWeth]>LYFE
            checkPath(
                [
                    'linearUSDC',
                    'bbaUSD-Pool',
                    'weightedWeth-BBausd',
                    'weightedBalWeth',
                ],
                poolsAllDict,
                paths[0],
                tokenIn,
                tokenOut
            );

            checkPath(
                ['weightedUsdcWeth', 'weightedBalWeth'],
                poolsAllDict,
                paths[1],
                tokenIn,
                tokenOut
            );
        });
        it('should return 2 valid linear paths, LYFE>USDC', async () => {
            const tokenIn = LYFE.address;
            const tokenOut = USDC.address;
            const maxPools = 10;

            const [paths, poolsAllDict] = getPaths(
                tokenIn,
                tokenOut,
                SwapTypes.SwapExactIn,
                smallLinear.pools,
                maxPools
            );
            assert.equal(paths.length, 2);

            // LYFE>[BalWeth]>WETH>[staLYFE3Weth]>staLyfe3Lbpt>[staLYFE3]>lUSDC>[linearUSDC]>USDC
            checkPath(
                [
                    'weightedBalWeth',
                    'weightedWeth-BBausd',
                    'bbaUSD-Pool',
                    'linearUSDC',
                ],
                poolsAllDict,
                paths[0],
                tokenIn,
                tokenOut
            );
            checkPath(
                ['weightedBalWeth', 'weightedUsdcWeth'],
                poolsAllDict,
                paths[1],
                tokenIn,
                tokenOut
            );
        });
    });

    context('AUTO Full Swaps', () => {
        context('Linear Pool Swaps', () => {
            context('MainToken<>LBPT', () => {
                it('MainToken>LBPT, SwapExactIn', async () => {
                    const returnAmount = await testFullSwap(
                        USDT.address,
                        LINEAR_AUSDT.address,
                        SwapTypes.SwapExactIn,
                        parseFixed('25.001542', USDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('25004552099099202302');
                });

                it('MainToken>LBPT, SwapExactOut', async () => {
                    const returnAmount = await testFullSwap(
                        USDT.address,
                        LINEAR_AUSDT.address,
                        SwapTypes.SwapExactOut,
                        parseFixed('0.981028', LINEAR_AUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('980910');
                });

                it('LBPT>MainToken, SwapExactIn', async () => {
                    const returnAmount = await testFullSwap(
                        LINEAR_AUSDT.address,
                        USDT.address,
                        SwapTypes.SwapExactIn,
                        parseFixed('26.0872140', LINEAR_AUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('26084073');
                });

                it('LBPT>MainToken, SwapExactOut', async () => {
                    const returnAmount = await testFullSwap(
                        LINEAR_AUSDT.address,
                        USDT.address,
                        SwapTypes.SwapExactOut,
                        parseFixed('71.204293', USDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('71212865750361503175');
                });

                it('MainToken>LBPT, SwapExactIn, No MainToken Initial Balance', async () => {
                    const pools = cloneDeep(kovanPools.pools);
                    pools[3].tokens[0].priceRate = '1.151626716668872399';
                    const returnAmount = await testFullSwap(
                        DAI.address,
                        LINEAR_ADAI.address,
                        SwapTypes.SwapExactIn,
                        parseFixed('491.23098', DAI.decimals),
                        pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('491230979220188637567');
                });
            });

            context('WrappedToken<>LBPT', () => {
                it('WrappedToken>LBPT, SwapExactIn', async () => {
                    const returnAmount = await testFullSwap(
                        aUSDT.address,
                        LINEAR_AUSDT.address,
                        SwapTypes.SwapExactIn,
                        parseFixed('25.001542', aUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('25019071730792915900');
                });

                it('WrappedToken>LBPT, SwapExactOut', async () => {
                    const returnAmount = await testFullSwap(
                        aUSDT.address,
                        LINEAR_AUSDT.address,
                        SwapTypes.SwapExactOut,
                        parseFixed('0.981028', LINEAR_AUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('980341');
                });

                it('LBPT>WrappedToken, SwapExactIn', async () => {
                    const returnAmount = await testFullSwap(
                        LINEAR_AUSDT.address,
                        aUSDT.address,
                        SwapTypes.SwapExactIn,
                        parseFixed('26.0872140', LINEAR_AUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('26068935');
                });

                it('LBPT>WrappedToken, SwapExactOut', async () => {
                    const returnAmount = await testFullSwap(
                        LINEAR_AUSDT.address,
                        aUSDT.address,
                        SwapTypes.SwapExactOut,
                        parseFixed('71.204293', aUSDT.decimals),
                        kovanPools.pools,
                        autoConfigKovan
                    );
                    expect(returnAmount).to.eq('71254217604154012028');
                });
            });
        });

        context('Stable Swaps Via StaBal3', () => {
            it('DAI>USDC, SwapExactIn', async () => {
                const returnAmount = await testFullSwap(
                    DAI.address,
                    USDT.address,
                    SwapTypes.SwapExactIn,
                    parseFixed('10.23098', DAI.decimals),
                    kovanPools.pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('10127143');
            });

            it('DAI>USDT, SwapExactOut', async () => {
                const pools = cloneDeep(kovanPools.pools);
                pools[3].tokens[0].priceRate = '1.151626716671544199';
                pools[2].tokens[2].priceRate = '1.000680737603270490';

                const returnAmount = await testFullSwap(
                    DAI.address,
                    USDT.address,
                    SwapTypes.SwapExactOut,
                    parseFixed('0.123456', USDT.decimals),
                    pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('124721185153919558');
            });
        });

        context('Stable <> Token paired with WETH', () => {
            it('USDT>LYFE, SwapExactIn', async () => {
                const returnAmount = await testFullSwap(
                    AAVE_USDT.address,
                    KOVAN_LYFE.address,
                    SwapTypes.SwapExactIn,
                    parseFixed('7.21', AAVE_USDT.decimals),
                    fullKovanPools.pools,
                    autoConfigFullKovan
                );
                expect(returnAmount).to.eq('6606146264948964392');
            });

            it('LYFE>USDT, SwapExactIn', async () => {
                const tokenIn = KOVAN_LYFE;
                const tokenOut = AAVE_USDT;
                await testFullSwap(
                    tokenIn.address,
                    tokenOut.address,
                    SwapTypes.SwapExactIn,
                    parseFixed('10.8248', KOVAN_LYFE.decimals),
                    fullKovanPools.pools,
                    autoConfigFullKovan
                );
                // expect(returnAmount).to.eq('70169832');
                // from worse path: 11061470
                assert(
                    checkBestPath(
                        tokenIn,
                        tokenOut,
                        SwapTypes.SwapExactIn,
                        10.8248,
                        fullKovanPools.pools,
                        autoConfigFullKovan
                    ),
                    'AUTO path is not the best one'
                );
            });

            it('USDT>LYFE, SwapExactOut', async () => {
                const returnAmount = await testFullSwap(
                    AAVE_USDT.address,
                    KOVAN_LYFE.address,
                    SwapTypes.SwapExactOut,
                    parseFixed('0.652413919893769122', KOVAN_LYFE.decimals),
                    fullKovanPools.pools,
                    autoConfigFullKovan
                );
                expect(returnAmount).to.eq('702055');
            });

            it('LYFE>USDT, SwapExactOut', async () => {
                const returnAmount = await testFullSwap(
                    KOVAN_LYFE.address,
                    AAVE_USDT.address,
                    SwapTypes.SwapExactOut,
                    parseFixed('71.990116', AAVE_USDT.decimals),
                    fullKovanPools.pools,
                    autoConfigFullKovan
                );
                expect(returnAmount).to.eq('81899098582251741376');
            });
        });

        context('Relayer Routes', () => {
            it('DAI>staLYFE3, SwapExactIn', async () => {
                const pools = cloneDeep(kovanPools.pools);
                pools[3].tokens[0].priceRate = '1.151626716671767642';
                const returnAmount = await testFullSwap(
                    DAI.address,
                    bbaUSD.address,
                    SwapTypes.SwapExactIn,
                    parseFixed('1', DAI.decimals),
                    pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('989985749906811070');
            });

            it('USDT>staLYFE3, SwapExactOut', async () => {
                const returnAmount = await testFullSwap(
                    USDT.address,
                    bbaUSD.address,
                    SwapTypes.SwapExactOut,
                    parseFixed('1', bbaUSD.decimals),
                    kovanPools.pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('1009969');
            });

            it('staLYFE3>USDT, SwapExactIn', async () => {
                const returnAmount = await testFullSwap(
                    bbaUSD.address,
                    USDT.address,
                    SwapTypes.SwapExactIn,
                    parseFixed('1', bbaUSD.decimals),
                    kovanPools.pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('989869');
            });

            it('staLYFE3>USDT, SwapExactOut', async () => {
                const returnAmount = await testFullSwap(
                    bbaUSD.address,
                    USDT.address,
                    SwapTypes.SwapExactOut,
                    parseFixed('1', USDT.decimals),
                    kovanPools.pools,
                    autoConfigKovan
                );
                expect(returnAmount).to.eq('1010233805404347502');
            });

            // it('aUSDT>staLYFE3, SwapExactIn', async () => {
            //     const returnAmount = await testFullSwap(
            //         aUSDT.address,
            //         bbaUSD.address,
            //         SwapTypes.SwapExactIn,
            //         parseFixed('1', aUSDT.decimals),
            //         kovanPools.pools,
            //         42
            //     );
            //     expect(returnAmount).to.eq('990684553495117616'); // TO DO - This will fail until we support wrapped tokens. Remove if decided we def won't
            // });

            //     it('aDAI>WETH, SwapExactIn', async () => {
            //         const returnAmount = await testFullSwap(
            //             aDAI.address,
            //             WETH.address,
            //             SwapTypes.SwapExactIn,
            //             parseFixed('1', staLYFE3.decimals),
            //             smallLinear.pools
            //         );
            //         expect(returnAmount).to.eq('468734616507406'); // TO DO - This will fail until we support wrapped tokens. Remove if decided we def won't
            //     });
        });
    });
});

function getPaths(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    pools: SubgraphPoolBase[],
    maxPools: number,
    config?: AutoConfig
): [NewPath[], PoolDictionary, NewPath[]] {
    const poolsAll = parseToPoolsDict(cloneDeep(pools), 0);
    const conf = config || autoConfigTest;
    const routeProposer = new RouteProposer(conf);
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

    const boostedPaths = getBoostedPaths(tokenIn, tokenOut, poolsAll, conf);
    return [paths, poolsAll, boostedPaths];
}

export async function testFullSwap(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    swapAmount: BigNumber,
    pools: SubgraphPoolBase[],
    config: AutoConfig = autoConfigTest
): Promise<string> {
    const returnAmountDecimals = 18; // TO DO Remove?
    const maxPools = 4;
    // const costOutputToken = BigNumber.from('1000000000000000000');
    const costOutputToken = BigNumber.from('0');
    const gasPrice = BigNumber.from(`10000000000`);
    const provider = new JsonRpcProvider(
        `https://mainnet.infura.io/v3/${process.env.INFURA}`
    );
    const swapGas = BigNumber.from(`32500`);

    const swapInfo = await getFullSwap(
        cloneDeep(pools),
        tokenIn,
        tokenOut,
        returnAmountDecimals,
        maxPools,
        swapType,
        swapAmount,
        costOutputToken,
        gasPrice,
        provider,
        swapGas,
        config
    );

    const totalSwapAmount = getTotalSwapAmount(swapType, swapInfo);
    assert.equal(
        swapAmount.toString(),
        totalSwapAmount.toString(),
        'Total From SwapInfo Should Equal Swap Amount.'
    );
    console.log(swapInfo.swaps);
    console.log(swapInfo.tokenAddresses);
    console.log(`Return: ${swapInfo.returnAmount.toString()}`);
    console.log(
        `ReturnFees: ${swapInfo.returnAmountConsideringFees.toString()}`
    );
    return swapInfo.returnAmount.toString();
}

function testLimit(
    tokenIn: string,
    tokenOut: string,
    swapType: SwapTypes,
    pools: SubgraphPoolBase[],
    poolIndex: number,
    expectedAmt: OldBigNumber
) {
    const pool = LinearPool.fromPool(cloneDeep(pools)[poolIndex]);
    const poolPairData = pool.parsePoolPairData(tokenIn, tokenOut);
    const limitAmt = pool.getLimitAmountSwap(poolPairData, swapType);
    expect(limitAmt.toString()).to.eq(expectedAmt.toString());
}

function testParsePool(
    poolSG: SubgraphPoolBase,
    tokenIn: TestToken,
    tokenOut: TestToken,
    pairType: PairTypes
) {
    const tokenIndexIn = poolSG.tokens.findIndex(
        (t) => t.address === tokenIn.address
    );
    const tokenIndexOut = poolSG.tokens.findIndex(
        (t) => t.address === tokenOut.address
    );

    const pool = LinearPool.fromPool(poolSG);

    const poolPairData = pool.parsePoolPairData(
        tokenIn.address,
        tokenOut.address
    );
    if (!poolSG.wrappedIndex || !poolSG.lowerTarget || !poolSG.upperTarget)
        return;
    expect(poolPairData.id).to.eq(poolSG.id);
    expect(poolPairData.address).to.eq(poolSG.address);
    expect(poolPairData.tokenIn).to.eq(tokenIn.address);
    expect(poolPairData.tokenOut).to.eq(tokenOut.address);
    expect(poolPairData.decimalsIn).to.eq(tokenIn.decimals);
    expect(poolPairData.decimalsOut).to.eq(tokenOut.decimals);
    expect(poolPairData.poolType).to.eq(PoolTypes.Linear);
    expect(poolPairData.swapFee.toString()).to.eq(
        parseFixed(poolSG.swapFee, 18).toString()
    );
    expect(poolPairData.balanceIn.toString()).to.eq(
        parseFixed(
            poolSG.tokens[tokenIndexIn].balance,
            poolSG.tokens[tokenIndexIn].decimals
        ).toString()
    );
    expect(poolPairData.balanceOut.toString()).to.eq(
        parseFixed(
            poolSG.tokens[tokenIndexOut].balance,
            poolSG.tokens[tokenIndexOut].decimals
        ).toString()
    );
    expect(poolPairData.pairType).to.eq(pairType);
    expect(poolPairData.wrappedDecimals).to.eq(
        poolSG.tokens[poolSG.wrappedIndex].decimals
    );
    expect(poolPairData.wrappedBalance.toString()).to.eq(
        parseFixed(
            poolSG.tokens[poolSG.wrappedIndex].balance,
            poolSG.tokens[poolSG.wrappedIndex].decimals
        ).toString()
    );
    expect(poolPairData.rate.toString()).to.eq(
        parseFixed(poolSG.tokens[poolSG.wrappedIndex].priceRate, 18).toString()
    );
    expect(poolPairData.lowerTarget.toString()).to.eq(
        parseFixed(poolSG.lowerTarget, 18).toString()
    );
    expect(poolPairData.upperTarget.toString()).to.eq(
        parseFixed(poolSG.upperTarget, 18).toString()
    );
}
