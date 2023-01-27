
<h1 align=center><code>Automatic Router (AUTO)</code></h1>

Automatic Router, or AUTO, is an off-chain linear optimization of routing orders across pools for best price execution.

AUTO aggregates liquidity across all Lyfebloc pools. Future releases of Lyfebloc will accomplish this on-chain and allow aggregate contract fillable liquidity.

Liquidity aggregators are free to use the AUTO npm package or create their own order routing across pools.



## Overview Of Use And Example

There are two types of swap available:

**swapExactIn** - i.e. You want to swap exactly 1 ETH as input and AUTO will calculate X amount of LYFE you receive in return.  
or  
**swapExactOut** - i.e. You want to receive exactly 1 LYFE and AUTO will calculate X amount of ETH you must input.

The AUTO will return totalReturn/totalInput as well as a list swaps to achieve the total. Swaps can be through direct pools, i.e. A > POOL1 > B, or via a multihop pool, i.e. A > POOL1 > C > POOL2 > B. The swaps are returned in a format that can be directly to the Reserve to execute the trade.

The example file `swapExample.ts` in: [./testScripts](test/testScripts/), demonstrates full examples with comments.

To Run:

Create a .env file in root dir with your infura provider key: `INFURA=your_key`

Install dependencies: `$ yarn install`

Run example: `$ ts-node ./test/testScripts/swapExample.ts`

## Environment Variables

Optional config values can be set in the .env file:

PRICE_ERROR_TOLERANCE - how close we expect prices after swap to be in AUTO suggested paths. Defaults 0.00001.

INFINITESIMAL - Infinitesimal is an amount that's used to initialize swap amounts so they are not zero or the path's limit. Defaults 0.000001.

Example:

```
PRICE_ERROR_TOLERANCE=0.00001
INFINITESIMAL=0.000001
```

## 
