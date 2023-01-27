import { BigNumber, parseFixed, formatFixed } from '@ethersproject/bignumber';
import { bnum, INFINITY, scale, ZERO } from '../../utils/bignumber';
import { BigNumber as OldBigNumber } from '../../utils/bignumber';
import { WeiPerEther as ONE, Zero } from '@ethersproject/constants';
import { isSameAddress } from '../../utils';
import {
    PoolBase,
    PoolTypes,
    PoolPairBase,
    SwapTypes,
    SubgraphPoolBase,
    SubgraphToken,
} from '../../types';
import {
    _calcLbptOutPerMainIn,
    _calcLbptInPerWrappedOut,
    _calcLbptInPerMainOut,
    _calcWrappedOutPerMainIn,
    _calcWrappedInPerMainOut,
    _calcMainInPerLbptOut,
    _calcMainOutPerLbptIn,
    _calcMainOutPerWrappedIn,
    _calcMainInPerWrappedOut,
    _calcLbptOutPerWrappedIn,
    _calcWrappedInPerLbptOut,
    _calcWrappedOutPerLbptIn,
    _spotPriceAfterSwapLbptOutPerMainIn,
    _spotPriceAfterSwapMainOutPerLbptIn,
    _spotPriceAfterSwapLbptOutPerWrappedIn,
    _spotPriceAfterSwapWrappedOutPerLbptIn,
    _spotPriceAfterSwapWrappedOutPerMainIn,
    _spotPriceAfterSwapMainOutPerWrappedIn,
    _spotPriceAfterSwapMainInPerLbptOut,
    _spotPriceAfterSwapLbptInPerMainOut,
    _spotPriceAfterSwapWrappedInPerLbptOut,
    _spotPriceAfterSwapLbptInPerWrappedOut,
    _spotPriceAfterSwapMainInPerWrappedOut,
    _spotPriceAfterSwapWrappedInPerMainOut,
} from './linearMath';

export enum PairTypes {
    LbptToMainToken,
    MainTokenToLbpt,
    MainTokenToWrappedToken,
    WrappedTokenToMainToken,
    LbptToWrappedToken,
    WrappedTokenToLbpt,
}

type LinearPoolToken = Pick<
    SubgraphToken,
    'address' | 'balance' | 'decimals' | 'priceRate'
>;

export type LinearPoolPairData = PoolPairBase & {
    pairType: PairTypes;
    wrappedBalance: OldBigNumber; // If main token is USDC then wrapped token is aUSDC (or a wrapped version of it)
    wrappedBalanceScaled: BigNumber; // If main token is USDC then wrapped token is aUSDC (or a wrapped version of it)
    wrappedDecimals: number;
    rate: BigNumber; // PriceRate of wrapped token
    lowerTarget: BigNumber; // Target determine the range where there are positive, zero or negative fees
    upperTarget: BigNumber; // when the "main token" has a balance below lowerTarget, there are negative fees when adding main token
    mainBalanceScaled: BigNumber; // Scaled are used for EVM/SDK maths
    bptBalanceScaled: BigNumber;
    virtualLbptSupply: BigNumber;
};

export class LinearPool implements PoolBase<LinearPoolPairData> {
    poolType: PoolTypes = PoolTypes.Linear;
    id: string;
    address: string;
    swapFee: BigNumber;
    totalShares: BigNumber;
    tokens: LinearPoolToken[];
    tokensList: string[];

    wrappedIndex: number;
    wrappedDecimals: number;
    mainIndex: number;
    bptIndex: number;
    lowerTarget: BigNumber;
    upperTarget: BigNumber;
    MAX_RATIO = parseFixed('10', 18); // Specific for Linear pool types
    ALMOST_ONE = parseFixed('0.99', 18);
    // Used for VirutalLbpt and can be removed if SG is updated with VirtualLbpt value
    MAX_TOKEN_BALANCE = BigNumber.from('2').pow('112').sub('1');

    static fromPool(pool: SubgraphPoolBase): LinearPool {
        if (pool.mainIndex === undefined)
            throw new Error('LinearPool missing mainIndex');
        if (pool.wrappedIndex === undefined)
            throw new Error('LinearPool missing wrappedIndex');
        if (!pool.lowerTarget)
            throw new Error('LinearPool missing lowerTarget');
        if (!pool.upperTarget)
            throw new Error('LinearPool missing upperTarget');
        return new LinearPool(
            pool.id,
            pool.address,
            pool.swapFee,
            pool.totalShares,
            pool.tokens,
            pool.tokensList,
            pool.mainIndex,
            pool.wrappedIndex,
            pool.lowerTarget,
            pool.upperTarget
        );
    }

    constructor(
        id: string,
        address: string,
        swapFee: string,
        totalShares: string,
        tokens: LinearPoolToken[],
        tokensList: string[],
        mainIndex: number,
        wrappedIndex: number,
        lowerTarget: string,
        upperTarget: string
    ) {
        this.id = id;
        this.address = address;
        this.swapFee = parseFixed(swapFee, 18);
        this.totalShares = parseFixed(totalShares, 18);
        this.tokens = tokens;
        this.tokensList = tokensList;
        this.mainIndex = mainIndex;
        this.bptIndex = this.tokensList.indexOf(this.address);
        this.wrappedIndex = wrappedIndex;
        this.wrappedDecimals = this.tokens[this.wrappedIndex].decimals;
        this.lowerTarget = parseFixed(lowerTarget, 18); // Wrapped token will have same decimals as underlying
        this.upperTarget = parseFixed(upperTarget, 18);
    }

    parsePoolPairData(tokenIn: string, tokenOut: string): LinearPoolPairData {
        let pairType: PairTypes;

        const tI = this.tokens.find((t) => isSameAddress(t.address, tokenIn));
        if (!tI) throw Error(`Pool does not contain token in ${tokenIn}`);
        const decimalsIn = tI.decimals;
        const balanceIn = parseFixed(tI.balance, decimalsIn);

        const tO = this.tokens.find((t) => isSameAddress(t.address, tokenOut));
        if (!tO) throw Error(`Pool does not contain token out ${tokenOut}`);
        const decimalsOut = tO.decimals;
        const balanceOut = parseFixed(tO.balance, decimalsOut);

        // Linear pools allow trading between token and pool LBPT (phantom LBPT)
        if (isSameAddress(tokenIn, this.address)) {
            if (isSameAddress(tokenOut, this.tokens[this.wrappedIndex].address))
                pairType = PairTypes.LbptToWrappedToken;
            else pairType = PairTypes.LbptToMainToken;
        } else if (isSameAddress(tokenOut, this.address)) {
            if (isSameAddress(tokenIn, this.tokens[this.wrappedIndex].address))
                pairType = PairTypes.WrappedTokenToLbpt;
            else pairType = PairTypes.MainTokenToLbpt;
        } else {
            if (isSameAddress(tokenIn, this.tokens[this.wrappedIndex].address))
                pairType = PairTypes.WrappedTokenToMainToken;
            else pairType = PairTypes.MainTokenToWrappedToken;
        }

        // Get all token balances scaled to 18
        const allBalancesScaled = this.tokens.map(({ balance }) =>
            parseFixed(balance, 18)
        );
        // https://github.com/Lyfebloc/Lyfebloc-v2-monorepo/blob/88a14eb623f6a22ef3f1afc5a8c49ebfa7eeceed/pkg/pool-linear/contracts/LinearPool.sol#L247
        // VirtualLBPTSupply must be used for the maths
        // TO DO - SG should be updated to so that totalShares should return VirtualSupply
        const bptBalanceScaled = allBalancesScaled[this.bptIndex];
        const virtualLbptSupply = this.MAX_TOKEN_BALANCE.sub(bptBalanceScaled);

        const poolPairData: LinearPoolPairData = {
            id: this.id,
            address: this.address,
            poolType: this.poolType,
            pairType: pairType,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            decimalsIn: Number(decimalsIn),
            decimalsOut: Number(decimalsOut),
            balanceIn: balanceIn,
            balanceOut: balanceOut,
            swapFee: this.swapFee,
            wrappedBalance: scale(
                bnum(this.tokens[this.wrappedIndex].balance),
                this.wrappedDecimals
            ),
            wrappedBalanceScaled: allBalancesScaled[this.wrappedIndex], // Note this is not multiplied by rate
            wrappedDecimals: this.wrappedDecimals,
            rate: parseFixed(this.tokens[this.wrappedIndex].priceRate, 18),
            lowerTarget: this.lowerTarget,
            upperTarget: this.upperTarget,
            mainBalanceScaled: allBalancesScaled[this.mainIndex],
            bptBalanceScaled,
            virtualLbptSupply,
        };

        return poolPairData;
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    getNormalizedLiquidity(poolPairData: LinearPoolPairData): OldBigNumber {
        return INFINITY; // It is the inverse of zero
        // This is correct since linear pools have no price impact,
        // except for the swap fee that is expected to be small.
    }

    getLimitAmountSwap(
        poolPairData: LinearPoolPairData,
        swapType: SwapTypes
    ): OldBigNumber {
        // Needs to return human scaled numbers
        const linearPoolPairData = poolPairData as LinearPoolPairData;
        const balanceOutHuman = scale(
            bnum(poolPairData.balanceOut.toString()),
            -poolPairData.decimalsOut
        );

        if (swapType === SwapTypes.SwapExactIn) {
            if (linearPoolPairData.pairType === PairTypes.MainTokenToLbpt) {
                return this._mainTokenInForExactLBPTOut(
                    poolPairData,
                    balanceOutHuman
                        .times(this.ALMOST_ONE.toString())
                        .div(ONE.toString())
                );
            } else if (
                linearPoolPairData.pairType === PairTypes.WrappedTokenToLbpt
            ) {
                // Swapping to LBPT allows for a very large amount so using pre-minted amount as estimation
                return scale(bnum(this.MAX_TOKEN_BALANCE.toString()), -18);
            } else if (
                linearPoolPairData.pairType === PairTypes.LbptToMainToken
            ) {
                // Limit is amount of LBPT in for pool balance of tokenOut
                // Amount must be in human scale
                return this._LBPTInForExactMainTokenOut(
                    linearPoolPairData,
                    balanceOutHuman
                        .times(this.ALMOST_ONE.toString())
                        .div(ONE.toString())
                );
            } else if (
                linearPoolPairData.pairType === PairTypes.LbptToWrappedToken
            ) {
                const limit = this._LBPTInForExactWrappedTokenOut(
                    poolPairData,
                    balanceOutHuman
                        .times(this.ALMOST_ONE.toString())
                        .div(ONE.toString())
                );
                // Returning Human scale
                return limit;
            } else if (
                linearPoolPairData.pairType ===
                    PairTypes.MainTokenToWrappedToken ||
                linearPoolPairData.pairType ===
                    PairTypes.WrappedTokenToMainToken
            ) {
                const limit = bnum(
                    poolPairData.balanceOut
                        .mul(this.ALMOST_ONE)
                        .div(ONE)
                        .toString()
                );
                return scale(limit, -poolPairData.decimalsOut);
            } else return bnum(0);
        } else {
            if (
                linearPoolPairData.pairType === PairTypes.MainTokenToLbpt ||
                linearPoolPairData.pairType === PairTypes.WrappedTokenToLbpt
            ) {
                const limit = bnum(
                    poolPairData.balanceOut
                        .mul(this.MAX_RATIO)
                        .div(ONE)
                        .toString()
                );
                return scale(limit, -poolPairData.decimalsOut);
            } else if (
                linearPoolPairData.pairType === PairTypes.LbptToMainToken ||
                linearPoolPairData.pairType === PairTypes.LbptToWrappedToken ||
                linearPoolPairData.pairType ===
                    PairTypes.MainTokenToWrappedToken ||
                linearPoolPairData.pairType ===
                    PairTypes.WrappedTokenToMainToken
            ) {
                const limit = bnum(
                    poolPairData.balanceOut
                        .mul(this.ALMOST_ONE)
                        .div(ONE)
                        .toString()
                );
                return scale(limit, -poolPairData.decimalsOut);
            } else return bnum(0);
        }
    }

    // Updates the balance of a given token for the pool
    updateTokenBalanceForPool(token: string, newBalance: BigNumber): void {
        // token is LBPT
        if (isSameAddress(this.address, token)) {
            this.updateTotalShares(newBalance);
        } else {
            const T = this.tokens.find((t) => isSameAddress(t.address, token));
            if (!T) throw Error('Pool does not contain this token');
            // Converts to human scaled number and saves.
            T.balance = formatFixed(newBalance, T.decimals);
        }
    }

    updateTotalShares(newTotalShares: BigNumber): void {
        this.totalShares = newTotalShares;
    }

    _exactTokenInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        if (poolPairData.pairType === PairTypes.MainTokenToLbpt) {
            return this._exactMainTokenInForLBPTOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.LbptToMainToken) {
            return this._exactLBPTInForMainTokenOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.WrappedTokenToLbpt) {
            return this._exactWrappedTokenInForLBPTOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.LbptToWrappedToken) {
            return this._exactLBPTInForWrappedTokenOut(poolPairData, amount);
        } else if (
            poolPairData.pairType === PairTypes.MainTokenToWrappedToken
        ) {
            return this._exactMainTokenInForWrappedOut(poolPairData, amount);
        } else if (
            poolPairData.pairType === PairTypes.WrappedTokenToMainToken
        ) {
            return this._exactWrappedTokenInForMainOut(poolPairData, amount);
        } else return bnum(0);
    }

    _exactWrappedTokenInForMainOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcMainOutPerWrappedIn(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _exactMainTokenInForWrappedOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcWrappedOutPerMainIn(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _exactMainTokenInForLBPTOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcLbptOutPerMainIn(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _exactLBPTInForMainTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcMainOutPerLbptIn(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _exactWrappedTokenInForLBPTOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amt = _calcLbptOutPerWrappedIn(
                parseFixed(amount.toString(), 18).toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _exactLBPTInForWrappedTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcWrappedOutPerLbptIn(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _tokenInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        if (poolPairData.pairType === PairTypes.MainTokenToLbpt) {
            return this._mainTokenInForExactLBPTOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.LbptToMainToken) {
            return this._LBPTInForExactMainTokenOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.WrappedTokenToLbpt) {
            return this._wrappedTokenInForExactLBPTOut(poolPairData, amount);
        } else if (poolPairData.pairType === PairTypes.LbptToWrappedToken) {
            return this._LBPTInForExactWrappedTokenOut(poolPairData, amount);
        } else if (
            poolPairData.pairType === PairTypes.MainTokenToWrappedToken
        ) {
            return this._mainTokenInForExactWrappedOut(poolPairData, amount);
        } else if (
            poolPairData.pairType === PairTypes.WrappedTokenToMainToken
        ) {
            return this._wrappedTokenInForExactMainOut(poolPairData, amount);
        } else return bnum(0); // LinearPool does not support TokenToToken
    }

    _wrappedTokenInForExactMainOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcWrappedInPerMainOut(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _mainTokenInForExactWrappedOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcMainInPerWrappedOut(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_DOWN mode (1)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsOut,
                1
            );
        } catch (err) {
            return ZERO;
        }
    }

    _mainTokenInForExactLBPTOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);
            // in = main
            // out = LBPT
            const amt = _calcMainInPerLbptOut(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_UP mode (0)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsIn,
                0
            );
        } catch (err) {
            return ZERO;
        }
    }

    _LBPTInForExactMainTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcLbptInPerMainOut(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_UP mode (0)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsIn,
                0
            );
        } catch (err) {
            return ZERO;
        }
    }

    _wrappedTokenInForExactLBPTOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amtScaled = parseFixed(amount.toString(), 18);

            const amt = _calcWrappedInPerLbptOut(
                amtScaled.toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_UP mode (0)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsIn,
                0
            );
        } catch (err) {
            return ZERO;
        }
    }

    _LBPTInForExactWrappedTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        try {
            // All values should use 1e18 fixed point
            // i.e. 1USDC => 1e18 not 1e6
            const amt = _calcLbptInPerWrappedOut(
                // amtNoRate.toBigInt(),
                parseFixed(amount.toString(), 18).toBigInt(),
                poolPairData.mainBalanceScaled.toBigInt(),
                poolPairData.wrappedBalanceScaled.toBigInt(),
                poolPairData.virtualLbptSupply.toBigInt(),
                {
                    fee: poolPairData.swapFee.toBigInt(),
                    lowerTarget: poolPairData.lowerTarget.toBigInt(),
                    upperTarget: poolPairData.upperTarget.toBigInt(),
                    rate: poolPairData.rate.toBigInt(),
                }
            );
            // return human readable number
            // Using BigNumber.js decimalPlaces (dp), allows us to consider token decimal accuracy correctly,
            // i.e. when using token with 2decimals 0.002 should be returned as 0
            // Uses ROUND_UP mode (0)
            return scale(bnum(amt.toString()), -18).dp(
                poolPairData.decimalsIn,
                0
            );
        } catch (err) {
            return ZERO;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcTokensOutGivenExactLbptIn(bptAmountIn: BigNumber): BigNumber[] {
        // Linear Pool doesn't have Exit Pool implementation
        return new Array(this.tokens.length).fill(Zero);
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _calcLbptOutGivenExactTokensIn(amountsIn: BigNumber[]): BigNumber {
        // Linear Pool doesn't have Join Pool implementation
        return Zero;
    }

    // SPOT PRICES AFTER SWAP

    _spotPriceAfterSwapExactTokenInForTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const bigintAmount = parseFixed(
            amount.dp(18).toString(),
            18
        ).toBigInt();
        const mainBalance = poolPairData.mainBalanceScaled.toBigInt();
        const wrappedBalance = poolPairData.wrappedBalanceScaled.toBigInt();
        const lbptSupply = poolPairData.virtualLbptSupply.toBigInt();
        const params = {
            fee: poolPairData.swapFee.toBigInt(),
            lowerTarget: poolPairData.lowerTarget.toBigInt(),
            upperTarget: poolPairData.upperTarget.toBigInt(),
            rate: poolPairData.rate.toBigInt(),
        };
        let result: bigint;
        if (poolPairData.pairType === PairTypes.MainTokenToLbpt) {
            result = _spotPriceAfterSwapLbptOutPerMainIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.LbptToMainToken) {
            result = _spotPriceAfterSwapMainOutPerLbptIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.WrappedTokenToLbpt) {
            result = _spotPriceAfterSwapLbptOutPerWrappedIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.LbptToWrappedToken) {
            result = _spotPriceAfterSwapWrappedOutPerLbptIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (
            poolPairData.pairType === PairTypes.MainTokenToWrappedToken
        ) {
            result = _spotPriceAfterSwapWrappedOutPerMainIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (
            poolPairData.pairType === PairTypes.WrappedTokenToMainToken
        ) {
            result = _spotPriceAfterSwapMainOutPerWrappedIn(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else return bnum(0);
        return scale(bnum(result.toString()), -18).dp(
            poolPairData.decimalsOut,
            0
        );
    }

    _spotPriceAfterSwapTokenInForExactTokenOut(
        poolPairData: LinearPoolPairData,
        amount: OldBigNumber
    ): OldBigNumber {
        const bigintAmount = parseFixed(
            amount.dp(18).toString(),
            18
        ).toBigInt();
        const mainBalance = poolPairData.mainBalanceScaled.toBigInt();
        const wrappedBalance = poolPairData.wrappedBalanceScaled.toBigInt();
        const lbptSupply = poolPairData.virtualLbptSupply.toBigInt();
        const params = {
            fee: poolPairData.swapFee.toBigInt(),
            lowerTarget: poolPairData.lowerTarget.toBigInt(),
            upperTarget: poolPairData.upperTarget.toBigInt(),
            rate: poolPairData.rate.toBigInt(),
        };
        let result: bigint;
        if (poolPairData.pairType === PairTypes.MainTokenToLbpt) {
            result = _spotPriceAfterSwapMainInPerLbptOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.LbptToMainToken) {
            result = _spotPriceAfterSwapLbptInPerMainOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.WrappedTokenToLbpt) {
            result = _spotPriceAfterSwapWrappedInPerLbptOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (poolPairData.pairType === PairTypes.LbptToWrappedToken) {
            result = _spotPriceAfterSwapLbptInPerWrappedOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (
            poolPairData.pairType === PairTypes.MainTokenToWrappedToken
        ) {
            result = _spotPriceAfterSwapMainInPerWrappedOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else if (
            poolPairData.pairType === PairTypes.WrappedTokenToMainToken
        ) {
            result = _spotPriceAfterSwapWrappedInPerMainOut(
                bigintAmount,
                mainBalance,
                wrappedBalance,
                lbptSupply,
                params
            );
        } else return bnum(0);
        return scale(bnum(result.toString()), -18).dp(
            poolPairData.decimalsOut,
            0
        );
    }

    _derivativeSpotPriceAfterSwapExactTokenInForTokenOut(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        poolPairData: LinearPoolPairData,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        amount: OldBigNumber
    ): OldBigNumber {
        return bnum(0);
    }

    _derivativeSpotPriceAfterSwapTokenInForExactTokenOut(
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        poolPairData: LinearPoolPairData,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        amount: OldBigNumber
    ): OldBigNumber {
        return bnum(0);
    }
}
