import {
    BigNumber,
    BigNumberish,
    formatFixed,
    parseFixed,
} from '@ethersproject/bignumber';
import { Zero } from '@ethersproject/constants';
import { bnum, ZERO } from '../utils/bignumber';
import * as weightedMath from '../pools/weightedPool/weightedMath';
import { WeightedPoolPairData } from '../pools/weightedPool/weightedPool';

/////////
/// UI Helpers
/////////

// Get LBPT amount for token amounts with zero-price impact
// This function is the same regardless of whether we are considering
// an Add or Remove liquidity operation: The spot prices of LBPT in tokens
// are the same regardless.
export function LBPTForTokensZeroPriceImpact(
    balances: BigNumberish[],
    decimals: number[],
    normalizedWeights: BigNumberish[],
    amounts: BigNumberish[],
    lbptTotalSupply: BigNumberish
): BigNumber {
    const amountLBPTOut = amounts.reduce((totalLbptOut, amountIn, i) => {
        // Calculate amount of LBPT gained per token in
        const poolPairData: WeightedPoolPairData = {
            balanceIn: balances[i],
            decimalsIn: decimals[i],
            balanceOut: lbptTotalSupply,
            weightIn: normalizedWeights[i],
            swapFee: Zero,
        } as WeightedPoolPairData;
        const LBPTPrice = weightedMath._spotPriceAfterSwapTokenInForExactLBPTOut(
            ZERO,
            poolPairData
        );

        // Multiply by amountIn to get contribution to total lbpt out
        const downscaledAmountIn = formatFixed(amountIn, decimals[i]);
        const downscaledLbptOut = bnum(downscaledAmountIn)
            .div(LBPTPrice)
            .toString();
        return BigNumber.from(totalLbptOut).add(
            parseFixed(downscaledLbptOut, 18)
        );
    }, Zero);

    return BigNumber.from(amountLBPTOut);
}
