import { getAddress } from '@ethersproject/address';
import { WeiPerEther as ONE, Zero } from '@ethersproject/constants';
import { formatFixed, BigNumber } from '@ethersproject/bignumber';
import { BigNumber as OldBigNumber, bnum, ZERO } from '../../utils/bignumber';

import {
    PoolBase,
    PoolPairBase,
    PoolTypes,
    SubgraphToken,
    SwapTypes,
    SubgraphPoolBase,
} from '../../types';
import {
    MultiEParams,
    DerivedMultiEParams,
    Vector2,
    normalizeBalances,
    balancesFromTokenInOut,
    reduceFee,
    addFee,
    virtualOffset0,
    virtualOffset1,
} from './multiEMath/multiEMathHelpers';
import { isSameAddress, safeParseFixed } from '../../utils';
import { mulDown, divDown } from '../multiHelpers/multiSignedFixedPoint';
import {
    calculateInvariantWithError,
    calcOutGivenIn,
    calcInGivenOut,
    calcSpotPriceAfterSwapOutGivenIn,
    calcSpotPriceAfterSwapInGivenOut,
    calcDerivativePriceAfterSwapOutGivenIn,
    calcDerivativeSpotPriceAfterSwapInGivenOut,
} from './multiEMath/multiEMath';
import { SWAP_LIMIT_FACTOR } from '../multiHelpers/constants';
import { universalNormalizedLiquidity } from '../liquidity';

export type MultiEPoolPairData = PoolPairBase & {
    tokenInIsToken0: boolean;
};

export type MultiEPoolToken = Pick<
    SubgraphToken,
    'address' | 'balance' | 'decimals'
>;

type MultiEParamsFromSubgraph = {
    alpha: string;
    beta: string;
    c: string;
    s: string;
    lambda: string;
};
type DerivedMultiEParamsFromSubgraph = {
    tauAlphaX: string;
    tauAlphaY: string;
    tauBetaX: string;
    tauBetaY: string;
    u: string;
    v: string;
    w: string;
    z: string;
    dSq: string;
};

export class MultiEPool implements PoolBase<MultiEPoolPairData> {
    poolType: PoolTypes = PoolTypes.MultiE;
    id: string;
    address: string;
    tokensList: string[];
    tokens: MultiEPoolToken[];
    swapFee: BigNumber;
    totalShares: BigNumber;
    multiEParams: MultiEParams;
    derivedMultiEParams: DerivedMultiEParams;

    static fromPool(pool: SubgraphPoolBase): MultiEPool {
        const {
            alpha,
            beta,
            c,
            s,
            lambda,
            tauAlphaX,
            tauAlphaY,
            tauBetaX,
            tauBetaY,
            u,
            v,
            w,
            z,
            dSq,
        } = pool;

        const multiEParams = {
            alpha,
            beta,
            c,
            s,
            lambda,
        };

        const derivedMultiEParams = {
            tauAlphaX,
            tauAlphaY,
            tauBetaX,
            tauBetaY,
            u,
            v,
            w,
            z,
            dSq,
        };

        if (
            !Object.values(multiEParams).every((el) => el) ||
            !Object.values(derivedMultiEParams).every((el) => el)
        )
            throw new Error(
                'Pool missing MultiE params and/or MultiE derived params'
            );

        return new MultiEPool(
            pool.id,
            pool.address,
            pool.swapFee,
            pool.totalShares,
            pool.tokens as MultiEPoolToken[],
            pool.tokensList,
            multiEParams as MultiEParamsFromSubgraph,
            derivedMultiEParams as DerivedMultiEParamsFromSubgraph
        );
    }

    constructor(
        id: string,
        address: string,
        swapFee: string,
        totalShares: string,
        tokens: MultiEPoolToken[],
        tokensList: string[],
        multiEParams: MultiEParamsFromSubgraph,
        derivedMultiEParams: DerivedMultiEParamsFromSubgraph
    ) {
        this.id = id;
        this.address = address;
        this.swapFee = safeParseFixed(swapFee, 18);
        this.totalShares = safeParseFixed(totalShares, 18);
        this.tokens = tokens;
        this.tokensList = tokensList;

        this.multiEParams = {
            alpha: safeParseFixed(multiEParams.alpha, 18),
            beta: safeParseFixed(multiEParams.beta, 18),
            c: safeParseFixed(multiEParams.c, 18),
            s: safeParseFixed(multiEParams.s, 18),
            lambda: safeParseFixed(multiEParams.lambda, 18),
        };

        this.derivedMultiEParams = {
            tauAlpha: {
                x: safeParseFixed(derivedMultiEParams.tauAlphaX, 38),
                y: safeParseFixed(derivedMultiEParams.tauAlphaY, 38),
            },
            tauBeta: {
                x: safeParseFixed(derivedMultiEParams.tauBetaX, 38),
                y: safeParseFixed(derivedMultiEParams.tauBetaY, 38),
            },
            u: safeParseFixed(derivedMultiEParams.u, 38),
            v: safeParseFixed(derivedMultiEParams.v, 38),
            w: safeParseFixed(derivedMultiEParams.w, 38),
            z: safeParseFixed(derivedMultiEParams.z, 38),
            dSq: safeParseFixed(derivedMultiEParams.dSq, 38),
        };
    }

    parsePoolPairData(tokenIn: string, tokenOut: string): MultiEPoolPairData {
        const tokenInIndex = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenIn)
        );
        if (tokenInIndex < 0) throw 'Pool does not contain tokenIn';
        const tI = this.tokens[tokenInIndex];
        const balanceIn = tI.balance;
        const decimalsIn = tI.decimals;

        const tokenOutIndex = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenOut)
        );
        if (tokenOutIndex < 0) throw 'Pool does not contain tokenOut';
        const tO = this.tokens[tokenOutIndex];
        const balanceOut = tO.balance;
        const decimalsOut = tO.decimals;

        const tokenInIsToken0 = tokenInIndex === 0;

        const poolPairData: MultiEPoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            balanceIn: safeParseFixed(balanceIn, decimalsIn),
            balanceOut: safeParseFixed(balanceOut, decimalsOut),
            swapFee: this.swapFee,
            tokenInIsToken0,
        };

        return poolPairData;
    }

    getNormalizedLiquidity(poolPairData: MultiEPoolPairData): OldBigNumber {
        return universalNormalizedLiquidity(
            this._derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                poolPairData,
                ZERO
            )
        );
    }

    getLimitAmountSwap(
        poolPairData: MultiEPoolPairData,
        swapType: SwapTypes
    ): OldBigNumber {
        if (swapType === SwapTypes.SwapExactIn) {
            const normalizedBalances = normalizeBalances(
                [poolPairData.balanceIn, poolPairData.balanceOut],
                [poolPairData.decimalsIn, poolPairData.decimalsOut]
            );
            const orderedNormalizedBalances = balancesFromTokenInOut(
                normalizedBalances[0],
                normalizedBalances[1],
                poolPairData.tokenInIsToken0
            );
            const [currentInvariant, invErr] = calculateInvariantWithError(
                orderedNormalizedBalances,
                this.multiEParams,
                this.derivedMultiEParams
            );
            const invariant: Vector2 = {
                x: currentInvariant.add(invErr.mul(2)),
                y: currentInvariant,
            };
            const virtualOffsetFunc = poolPairData.tokenInIsToken0
                ? virtualOffset0
                : virtualOffset1;
            const maxAmountInAssetInPool = virtualOffsetFunc(
                this.multiEParams,
                this.derivedMultiEParams,
                invariant
            ).sub(
                virtualOffsetFunc(
                    this.multiEParams,
                    this.derivedMultiEParams,
                    invariant,
                    true
                )
            );
            const limitAmountIn = maxAmountInAssetInPool.sub(
                normalizedBalances[0]
            );
            const limitAmountInPlusSwapFee = divDown(
                limitAmountIn,
                ONE.sub(poolPairData.swapFee)
            );
            return bnum(
                formatFixed(
                    mulDown(limitAmountInPlusSwapFee, SWAP_LIMIT_FACTOR),
                    18
                )
            );
        } else {
            return bnum(
                formatFixed(
                    mulDown(poolPairData.balanceOut, SWAP_LIMIT_FACTOR),
                    poolPairData.decimalsOut
                )
            );
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is LBPT
        if (isSameAddress(this.address, token)) {
            this.updateTotalShares(newBalance);
        } else {
            // token is underlying in the pool
            const T = this.tokens.find((t) => isSameAddress(t.address, token));
            if (!T) throw Error('Pool does not contain this token');
            T.balance = formatFixed(newBalance, T.decimals);
        }
    }

    updateTotalShares(newTotalShares: BigNumber): void {
        this.totalShares = newTotalShares;
    }

    _exactTokenInForTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );

        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };
        const inAmount = safeParseFixed(amount.toString(), 18);
        const inAmountLessFee = reduceFee(inAmount, poolPairData.swapFee);
        const outAmount = calcOutGivenIn(
            orderedNormalizedBalances,
            inAmountLessFee,
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant
        );
        return bnum(formatFixed(outAmount, 18));
    }

    _tokenInForExactTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );
        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };
        const outAmount = safeParseFixed(amount.toString(), 18);

        const inAmountLessFee = calcInGivenOut(
            orderedNormalizedBalances,
            outAmount,
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant
        );
        const inAmount = addFee(inAmountLessFee, poolPairData.swapFee);
        return bnum(formatFixed(inAmount, 18));
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcTokensOutGivenExactLbptIn(bptAmountIn: BigNumber): BigNumber[] {
        // Missing maths for this
        return new Array(this.tokens.length).fill(Zero);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcLbptOutGivenExactTokensIn(amountsIn: BigNumber[]): BigNumber {
        // Missing maths for this
        return Zero;
    }

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );
        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };
        const inAmount = safeParseFixed(amount.toString(), 18);
        const inAmountLessFee = reduceFee(inAmount, poolPairData.swapFee);
        const newSpotPrice = calcSpotPriceAfterSwapOutGivenIn(
            orderedNormalizedBalances,
            inAmountLessFee,
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant,
            poolPairData.swapFee
        );
        return bnum(formatFixed(newSpotPrice, 18));
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );
        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };
        const outAmount = safeParseFixed(amount.toString(), 18);
        const newSpotPrice = calcSpotPriceAfterSwapInGivenOut(
            orderedNormalizedBalances,
            outAmount,
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant,
            poolPairData.swapFee
        );
        return bnum(formatFixed(newSpotPrice, 18));
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const inAmount = safeParseFixed(amount.toString(), 18);
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );
        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };

        const derivative = calcDerivativePriceAfterSwapOutGivenIn(
            [
                orderedNormalizedBalances[0].add(
                    reduceFee(inAmount, poolPairData.swapFee)
                ),
                orderedNormalizedBalances[1],
            ],
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant,
            poolPairData.swapFee
        );
        return bnum(formatFixed(derivative, 18));
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: MultiEPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const normalizedBalances = normalizeBalances(
            [poolPairData.balanceIn, poolPairData.balanceOut],
            [poolPairData.decimalsIn, poolPairData.decimalsOut]
        );
        const orderedNormalizedBalances = balancesFromTokenInOut(
            normalizedBalances[0],
            normalizedBalances[1],
            poolPairData.tokenInIsToken0
        );
        const [currentInvariant, invErr] = calculateInvariantWithError(
            orderedNormalizedBalances,
            this.multiEParams,
            this.derivedMultiEParams
        );
        const invariant: Vector2 = {
            x: currentInvariant.add(invErr.mul(2)),
            y: currentInvariant,
        };
        const outAmount = safeParseFixed(amount.toString(), 18);
        const derivative = calcDerivativeSpotPriceAfterSwapInGivenOut(
            [
                orderedNormalizedBalances[0],
                orderedNormalizedBalances[1].sub(outAmount),
            ],
            poolPairData.tokenInIsToken0,
            this.multiEParams,
            this.derivedMultiEParams,
            invariant,
            poolPairData.swapFee
        );
        return bnum(formatFixed(derivative, 18));
    }
}
