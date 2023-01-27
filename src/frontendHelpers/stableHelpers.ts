import {
    BigNumber,
    BigNumberish,
    formatFixed,
    parseFixed,
} from '@ethersproject/bignumber';
import { Zero } from '@ethersproject/constants';
import { BigNumber as OldBigNumber, bnum, ZERO } from '../utils/bignumber';
import * as stableMath from '../pools/stablePool/stableMath';
import { StablePoolPairData } from '../pools/stablePool/stablePool';

/////////
/// UI Helpers
/////////

// Get LBPT amount for token amounts with zero-price impact
// This function is the same regardless of whether we are considering
// an Add or Remove liquidity operation: The spot prices of LBPT in tokens
// are the same regardless.
export function LBPTForTokensZeroPriceImpact(
    allBalances: BigNumberish[],
    decimals: number[],
    amounts: BigNumberish[], // This has to have the same lenght as allBalances
    lbptTotalSupply: BigNumberish,
    amp: BigNumberish
): BigNumber {
    if (allBalances.length != amounts.length)
        throw 'allBalances and amounts have to have same length';
    // Calculate the amount of LBPT adding this liquidity would result in
    // if there were no price impact, i.e. using the spot price of tokenIn/LBPT

    // We downscale the pool balances once as this will be reused across tokens
    const allBalancesDownScaled: OldBigNumber[] = allBalances.map(
        (balance, i) => bnum(formatFixed(balance, decimals[i]))
    );

    const amountLBPTOut = amounts.reduce((totalLbptOut, amountIn, i) => {
        // Calculate amount of LBPT gained per token in
        const poolPairData: StablePoolPairData = {
            amp: BigNumber.from(amp),
            allBalances: allBalancesDownScaled,
            tokenIndexIn: i,
            balanceOut: lbptTotalSupply,
            decimalsOut: 18,
            swapFee: Zero,
        } as unknown as StablePoolPairData;
        const LBPTPrice = stableMath._spotPriceAfterSwapTokenInForExactLBPTOut(
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
