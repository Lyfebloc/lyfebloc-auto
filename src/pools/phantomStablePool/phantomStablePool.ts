import { BigNumber, formatFixed, parseFixed } from '@ethersproject/bignumber';
import { WeiPerEther as ONE, Zero } from '@ethersproject/constants';
import { isSameAddress } from '../../utils';
import { BigNumber as OldBigNumber, bnum, ZERO } from '../../utils/bignumber';
import {
    PoolBase,
    PoolTypes,
    SwapTypes,
    SubgraphPoolBase,
    SubgraphToken,
} from '../../types';
import { getAddress } from '@ethersproject/address';
import {
    _calcLbptOutGivenExactTokensIn,
    _calcTokenOutGivenExactLbptIn,
    _calcOutGivenIn,
    _calcTokenInGivenExactLbptOut,
    _calcLbptInGivenExactTokensOut,
    _calcInGivenOut,
    _calcTokensOutGivenExactLbptIn,
} from '../stablePool/stableMathBigInt';
import * as phantomStableMath from '../phantomStablePool/phantomStableMath';
import { MetaStablePoolPairData } from '../metaStablePool/metaStablePool';
import cloneDeep from 'lodash.clonedeep';
import { universalNormalizedLiquidity } from '../liquidity';

enum PairTypes {
    LbptToToken,
    TokenToLbpt,
    TokenToToken,
}

type PhantomStablePoolToken = Pick<
    SubgraphToken,
    'address' | 'balance' | 'decimals' | 'priceRate'
>;

export type PhantomStablePoolPairData = MetaStablePoolPairData & {
    pairType: PairTypes;
    bptIndex: number;
    virtualLbptSupply: BigNumber;
};

export class PhantomStablePool implements PoolBase<PhantomStablePoolPairData> {
    poolType: PoolTypes = PoolTypes.MetaStable;
    id: string;
    address: string;
    amp: BigNumber;
    swapFee: BigNumber;
    totalShares: BigNumber;
    tokens: PhantomStablePoolToken[];
    tokensList: string[];
    ALMOST_ONE = parseFixed('0.99', 18);

    static AMP_DECIMALS = 3;

    static fromPool(pool: SubgraphPoolBase): PhantomStablePool {
        if (!pool.amp) throw new Error('PhantomStablePool missing amp factor');
        return new PhantomStablePool(
            pool.id,
            pool.address,
            pool.amp,
            pool.swapFee,
            pool.totalShares,
            pool.tokens,
            pool.tokensList
        );
    }

    // Remove LBPT from Balances and update indices
    static removeLBPT(
        poolPairData: PhantomStablePoolPairData
    ): PhantomStablePoolPairData {
        const poolPairDataNoLbpt = cloneDeep(poolPairData);
        const bptIndex = poolPairData.bptIndex;
        if (bptIndex != -1) {
            poolPairDataNoLbpt.allBalances.splice(bptIndex, 1);
            poolPairDataNoLbpt.allBalancesScaled.splice(bptIndex, 1);
            if (bptIndex < poolPairData.tokenIndexIn)
                poolPairDataNoLbpt.tokenIndexIn -= 1;
            if (bptIndex < poolPairData.tokenIndexOut)
                poolPairDataNoLbpt.tokenIndexOut -= 1;
        }
        return poolPairDataNoLbpt;
    }

    constructor(
        id: string,
        address: string,
        amp: string,
        swapFee: string,
        totalShares: string,
        tokens: PhantomStablePoolToken[],
        tokensList: string[]
    ) {
        this.id = id;
        this.address = address;
        this.amp = parseFixed(amp, PhantomStablePool.AMP_DECIMALS);
        this.swapFee = parseFixed(swapFee, 18);
        this.totalShares = parseFixed(totalShares, 18);
        this.tokens = tokens;
        this.tokensList = tokensList;
    }

    parsePoolPairData(
        tokenIn: string,
        tokenOut: string
    ): PhantomStablePoolPairData {
        const tokenIndexIn = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenIn)
        );
        if (tokenIndexIn < 0) throw 'Pool does not contain tokenIn';
        const tI = this.tokens[tokenIndexIn];
        const balanceIn = bnum(tI.balance)
            .times(bnum(tI.priceRate))
            .dp(tI.decimals)
            .toString();
        const decimalsIn = tI.decimals;
        const tokenInPriceRate = parseFixed(tI.priceRate, 18);

        const tokenIndexOut = this.tokens.findIndex(
            (t) => getAddress(t.address) === getAddress(tokenOut)
        );
        if (tokenIndexOut < 0) throw 'Pool does not contain tokenOut';
        const tO = this.tokens[tokenIndexOut];
        const balanceOut = bnum(tO.balance)
            .times(bnum(tO.priceRate))
            .dp(tO.decimals)
            .toString();
        const decimalsOut = tO.decimals;
        const tokenOutPriceRate = parseFixed(tO.priceRate, 18);

        // Get all token balances
        const allBalances = this.tokens.map(({ balance, priceRate }) =>
            bnum(balance).times(bnum(priceRate))
        );
        const allBalancesScaled = this.tokens.map(({ balance, priceRate }) =>
            parseFixed(balance, 18).mul(parseFixed(priceRate, 18)).div(ONE)
        );

        // Phantom pools allow trading between token and pool LBPT
        let pairType: PairTypes;
        if (isSameAddress(tokenIn, this.address)) {
            pairType = PairTypes.LbptToToken;
        } else if (isSameAddress(tokenOut, this.address)) {
            pairType = PairTypes.TokenToLbpt;
        } else {
            pairType = PairTypes.TokenToToken;
        }

        const bptIndex = this.tokensList.indexOf(this.address);

        // VirtualLBPTSupply must be used for the maths
        const virtualLbptSupply = this.totalShares;

        const poolPairData: PhantomStablePoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            pairType: pairType,
            bptIndex: bptIndex,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            balanceIn: parseFixed(balanceIn, decimalsIn),
            balanceOut: parseFixed(balanceOut, decimalsOut),
            swapFee: this.swapFee,
            allBalances,
            allBalancesScaled,
            amp: this.amp,
            tokenIndexIn: tokenIndexIn,
            tokenIndexOut: tokenIndexOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            tokenInPriceRate,
            tokenOutPriceRate,
            virtualLbptSupply,
        };

        return PhantomStablePool.removeLBPT(poolPairData);
    }

    getNormalizedLiquidity(
        poolPairData: PhantomStablePoolPairData
    ): OldBigNumber {
        return universalNormalizedLiquidity(
            this._derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                poolPairData,
                ZERO
            )
        );
    }

    getLimitAmountSwap(
        poolPairData: PhantomStablePoolPairData,
        swapType: SwapTypes
    ): OldBigNumber {
        // PoolPairData is using balances that have already been exchanged so need to convert back
        if (swapType === SwapTypes.SwapExactIn) {
            // Return max valid amount of tokenIn
            // As an approx - use almost the total balance of token out as we can add any amount of tokenIn and expect some back
            return bnum(
                formatFixed(
                    poolPairData.balanceOut
                        .mul(this.ALMOST_ONE)
                        .div(poolPairData.tokenOutPriceRate),
                    poolPairData.decimalsOut
                )
            );
        } else {
            // Return max amount of tokenOut - approx is almost all balance
            return bnum(
                formatFixed(
                    poolPairData.balanceOut
                        .mul(this.ALMOST_ONE)
                        .div(poolPairData.tokenOutPriceRate),
                    poolPairData.decimalsOut
                )
            );
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is underlying in the pool
        const T = this.tokens.find((t) => isSameAddress(t.address, token));
        if (!T) throw Error('Pool does not contain this token');

        // update total shares with LBPT balance diff
        if (isSameAddress(this.address, token)) {
            const parsedTokenBalance = parseFixed(T.balance, T.decimals);
            const diff = parsedTokenBalance.sub(newBalance);
            const newTotalShares = this.totalShares.add(diff);
            this.updateTotalShares(newTotalShares);
        }
        // update token balance with new balance
        T.balance = formatFixed(newBalance, T.decimals);
    }

    updateTotalShares(newTotalShares: BigNumber): void {
        this.totalShares = newTotalShares;
    }

    _exactTokenInForTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // This code assumes that decimalsIn and decimalsOut is 18

            if (amount.isZero()) return ZERO;
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            // In Phantom Pools every time there is a swap (token per token, lbpt per token or token per lbpt), we substract the fee from the amount in
            const amtWithFeeEvm = this.subtractSwapFeeAmount(
                parseFixed(amount.dp(18).toString(), 18),
                poolPairData.swapFee
            );
            const amountConvertedEvm = amtWithFeeEvm
                .mul(poolPairData.tokenInPriceRate)
                .div(ONE);

            let returnEvm: BigInt;

            if (poolPairData.pairType === PairTypes.TokenToLbpt) {
                const amountsInBigInt = Array(
                    poolPairData.allBalancesScaled.length
                ).fill(BigInt(0));
                amountsInBigInt[poolPairData.tokenIndexIn] =
                    amountConvertedEvm.toBigInt();

                returnEvm = _calcLbptOutGivenExactTokensIn(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    amountsInBigInt,
                    poolPairData.virtualLbptSupply.toBigInt(),
                    BigInt(0)
                );
            } else if (poolPairData.pairType === PairTypes.LbptToToken) {
                returnEvm = _calcTokenOutGivenExactLbptIn(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    poolPairData.tokenIndexOut,
                    amountConvertedEvm.toBigInt(),
                    poolPairData.virtualLbptSupply.toBigInt(),
                    BigInt(0)
                );
            } else {
                returnEvm = _calcOutGivenIn(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    poolPairData.tokenIndexIn,
                    poolPairData.tokenIndexOut,
                    amountConvertedEvm.toBigInt(),
                    BigInt(0)
                );
            }

            const returnEvmWithRate = BigNumber.from(returnEvm)
                .mul(ONE)
                .div(poolPairData.tokenOutPriceRate);

            // Return human scaled
            return bnum(formatFixed(returnEvmWithRate, 18));
        } catch (err) {
            // console.error(`PhantomStable _evmoutGivenIn: ${err.message}`);
            return ZERO;
        }
    }

    _tokenInForExactTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // This code assumes that decimalsIn and decimalsOut is 18

            if (amount.isZero()) return ZERO;
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amountConvertedEvm = parseFixed(amount.dp(18).toString(), 18)
                .mul(poolPairData.tokenOutPriceRate)
                .div(ONE);

            let returnEvm: BigInt;

            if (poolPairData.pairType === PairTypes.TokenToLbpt) {
                returnEvm = _calcTokenInGivenExactLbptOut(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    poolPairData.tokenIndexIn,
                    amountConvertedEvm.toBigInt(),
                    poolPairData.virtualLbptSupply.toBigInt(),
                    BigInt(0)
                );
            } else if (poolPairData.pairType === PairTypes.LbptToToken) {
                const amountsOutBigInt = Array(
                    poolPairData.allBalancesScaled.length
                ).fill(BigInt(0));
                amountsOutBigInt[poolPairData.tokenIndexOut] =
                    amountConvertedEvm.toBigInt();

                returnEvm = _calcLbptInGivenExactTokensOut(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    amountsOutBigInt,
                    poolPairData.virtualLbptSupply.toBigInt(),
                    BigInt(0) // Fee is handled below
                );
            } else {
                returnEvm = _calcInGivenOut(
                    this.amp.toBigInt(),
                    poolPairData.allBalancesScaled.map((b) => b.toBigInt()),
                    poolPairData.tokenIndexIn,
                    poolPairData.tokenIndexOut,
                    amountConvertedEvm.toBigInt(),
                    BigInt(0) // Fee is handled below
                );
            }
            // In Phantom Pools every time there is a swap (token per token, lbpt per token or token per lbpt), we substract the fee from the amount in
            const returnEvmWithRate = BigNumber.from(returnEvm)
                .mul(ONE)
                .div(poolPairData.tokenInPriceRate);

            const returnEvmWithFee = this.addSwapFeeAmount(
                returnEvmWithRate,
                poolPairData.swapFee
            );

            // return human number
            return bnum(formatFixed(returnEvmWithFee, 18));
        } catch (err) {
            console.error(`PhantomStable _evminGivenOut: ${err.message}`);
            return ZERO;
        }
    }

    /**
     * _calcTokensOutGivenExactLbptIn
     * @param bptAmountIn EVM scale.
     * @returns EVM scale.
     */
    _calcTokensOutGivenExactLbptIn(bptAmountIn: BigNumber): BigNumber[] {
        // token balances are stored in human scale and must be EVM for maths
        // Must take priceRate into consideration
        const balancesEvm = this.tokens
            .filter((t) => !isSameAddress(t.address, this.address))
            .map(({ balance, priceRate, decimals }) =>
                parseFixed(balance, 18)
                    .mul(parseFixed(priceRate, decimals))
                    .div(ONE)
                    .toBigInt()
            );
        let returnAmt: bigint[];
        try {
            returnAmt = _calcTokensOutGivenExactLbptIn(
                balancesEvm,
                bptAmountIn.toBigInt(),
                this.totalShares.toBigInt()
            );
            return returnAmt.map((a) => BigNumber.from(a.toString()));
        } catch (err) {
            return new Array(balancesEvm.length).fill(ZERO);
        }
    }

    /**
     * _calcLbptOutGivenExactTokensIn
     * @param amountsIn EVM Scale
     * @returns EVM Scale
     */
    _calcLbptOutGivenExactTokensIn(amountsIn: BigNumber[]): BigNumber {
        try {
            // token balances are stored in human scale and must be EVM for maths
            // Must take priceRate into consideration
            const balancesEvm = this.tokens
                .filter((t) => !isSameAddress(t.address, this.address))
                .map(({ balance, priceRate, decimals }) =>
                    parseFixed(balance, decimals)
                        .mul(parseFixed(priceRate, 18))
                        .div(ONE)
                        .toBigInt()
                );
            const bptAmountOut = _calcLbptOutGivenExactTokensIn(
                this.amp.toBigInt(),
                balancesEvm,
                amountsIn.map((a) => a.toBigInt()),
                this.totalShares.toBigInt(),
                BigInt(0)
            );
            return BigNumber.from(bptAmountOut.toString());
        } catch (err) {
            return Zero;
        }
    }

    // this is the multiplicative inverse of the derivative of _exactTokenInForTokenOut
    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const priceRateIn = bnum(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        const priceRateOut = bnum(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        const amountConverted = amount.times(
            bnum(formatFixed(poolPairData.tokenInPriceRate, 18))
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToLbpt) {
            result = phantomStableMath._spotPriceAfterSwapExactTokenInForLBPTOut(
                amountConverted,
                poolPairData
            );
        } else if (poolPairData.pairType === PairTypes.LbptToToken) {
            result = phantomStableMath._spotPriceAfterSwapExactLBPTInForTokenOut(
                amountConverted,
                poolPairData
            );
        } else {
            result =
                phantomStableMath._spotPriceAfterSwapExactTokenInForTokenOut(
                    amountConverted,
                    poolPairData
                );
        }
        return result.div(priceRateIn).times(priceRateOut);
    }

    // this is the derivative of _tokenInForExactTokenOut
    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const priceRateIn = bnum(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        const priceRateOut = bnum(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToLbpt) {
            result = phantomStableMath._spotPriceAfterSwapTokenInForExactLBPTOut(
                amountConverted,
                poolPairData
            );
        } else if (poolPairData.pairType === PairTypes.LbptToToken) {
            result = phantomStableMath._spotPriceAfterSwapLBPTInForExactTokenOut(
                amountConverted,
                poolPairData
            );
        } else {
            result =
                phantomStableMath._spotPriceAfterSwapTokenInForExactTokenOut(
                    amountConverted,
                    poolPairData
                );
        }
        return result.div(priceRateIn).times(priceRateOut);
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const priceRateOut = bnum(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToLbpt) {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapExactTokenInForLBPTOut(
                    amountConverted,
                    poolPairData
                );
        } else if (poolPairData.pairType === PairTypes.LbptToToken) {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapExactLBPTInForTokenOut(
                    amountConverted,
                    poolPairData
                );
        } else {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
                    amountConverted,
                    poolPairData
                );
        }
        return result.times(priceRateOut);
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: PhantomStablePoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const priceRateIn = bnum(
            formatFixed(poolPairData.tokenInPriceRate, 18)
        );
        const priceRateOut = bnum(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        const amountConverted = amount.times(
            formatFixed(poolPairData.tokenOutPriceRate, 18)
        );
        let result: OldBigNumber;
        if (poolPairData.pairType === PairTypes.TokenToLbpt) {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapTokenInForExactLBPTOut(
                    amountConverted,
                    poolPairData
                );
        } else if (poolPairData.pairType === PairTypes.LbptToToken) {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapLBPTInForExactTokenOut(
                    amountConverted,
                    poolPairData
                );
        } else {
            result =
                phantomStableMath._derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
                    amountConverted,
                    poolPairData
                );
        }
        return result.div(priceRateIn).times(priceRateOut).times(priceRateOut);
    }

    subtractSwapFeeAmount(amount: BigNumber, swapFee: BigNumber): BigNumber {
        // https://github.com/Lyfebloc/Lyfebloc-v2-monorepo/blob/c18ff2686c61a8cbad72cdcfc65e9b11476fdbc3/pkg/pool-utils/contracts/BasePool.sol#L466
        const feeAmount = amount.mul(swapFee).add(ONE.sub(1)).div(ONE);
        return amount.sub(feeAmount);
    }

    addSwapFeeAmount(amount: BigNumber, swapFee: BigNumber): BigNumber {
        // https://github.com/Lyfebloc/Lyfebloc-v2-monorepo/blob/c18ff2686c61a8cbad72cdcfc65e9b11476fdbc3/pkg/pool-utils/contracts/BasePool.sol#L458
        const feeAmount = ONE.sub(swapFee);
        return amount.mul(ONE).add(feeAmount.sub(1)).div(feeAmount);
    }
}
