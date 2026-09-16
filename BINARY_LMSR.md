# Binary LMSR Implementation

## Overview

Implements the Logarithmic Market Scoring Rule (LMSR) for binary (YES/NO) prediction markets with:
- **Decimal.js** for fixed-precision arithmetic (no float drift)
- **Log-sum-exp trick** for numerical stability (avoids overflow)
- **Complete state tracking** including `totalCollected` for settlement
- **Path-independent pricing** ensuring trade costs are order-independent

## Mathematical Foundation

### Cost Function (with Log-Sum-Exp for Stability)

```
C(q) = b * ln(e^(q_YES/b) + e^(q_NO/b))
```

Implemented stably using:
```
ln(e^x + e^y) = max(x,y) + ln(e^(x-max) + e^(y-max))
```

### Prices (using Sigmoid Form for Stability)

```
p_YES = 1 / (1 + e^(q_NO/b - q_YES/b))
p_NO = 1 / (1 + e^(q_YES/b - q_NO/b)) = 1 - p_YES
```

### Trade Cost (Path Independent)

```
Cost = C(q') - C(q)
```

## Market State Object

```typescript
interface BinaryMarketState {
  qYes: Decimal;          // YES shares held by traders
  qNo: Decimal;           // NO shares held by traders
  b: Decimal;             // Liquidity parameter
  totalCollected: Decimal; // Money collected from all trades
  settled: boolean;        // Whether market is settled
  outcome?: "YES" | "NO"; // Winning outcome if settled
}
```

## Key Features

### 1. Numerical Stability
- Uses log-sum-exp to avoid overflow with large quantities
- Sigmoid form for prices instead of naive exponentials
- All arithmetic in Decimal.js (28 decimal places precision)

### 2. Settlement
```typescript
// Settle market
const settlement = lmsr.settle(state, "YES");
// settlement.totalPayout = qYes (winning shares pay 1 each)
// settlement.profitLoss = totalCollected - totalPayout
```

### 3. Hypothetical P/L
```typescript
// Check profit/loss for either outcome
const profitIfYes = lmsr.hypotheticalProfitLoss(state, "YES");
const profitIfNo = lmsr.hypotheticalProfitLoss(state, "NO");
```

### 4. Average Execution Price
```typescript
const result = lmsr.buyYes(state, 10);
// result.avgPrice = cost / quantity (average price paid)
// result.priceYes = marginal price after trade
```

## LMSR Properties Verified

- ✓ **Bounded Loss**: Worst-case loss = `b * ln(2)`
- ✓ **Path Independence**: Sequential vs bulk trades have same cost
- ✓ **Prices in [0,1]**: Always valid probabilities
- ✓ **Prices Sum to 1**: `p_YES + p_NO = 1`
- ✓ **Monotonic Prices**: Buying YES increases p_YES, buying NO decreases it
- ✓ **Gradient Property**: Price = ∂C/∂q (verified numerically)

## Usage Example

```typescript
import { BinaryLMSR } from '@/lib/binaryLmsr';

const lmsr = new BinaryLMSR();
const state = lmsr.createInitialState(100); // b=100

// Buy shares
const r1 = lmsr.buyYes(state, 10);
const r2 = lmsr.buyNo(r1.newState, 5);

// Check prices
const prices = lmsr.prices(r2.newState);
console.log(prices.yes.toString(), prices.no.toString());

// Settle
const settlement = lmsr.settle(r2.newState, "YES");
console.log(`Payout: ${settlement.totalPayout}`);
console.log(`MM Profit: ${settlement.profitLoss}`);
```

## Testing

All 44 tests pass, covering:
- State creation and validation
- Cost function with log-sum-exp stability
- Price calculations (sigmoid form)
- Path independence of trades
- Settlement and profit/loss
- Edge cases (fractional shares, large quantities, overflow prevention)

Run tests with: `npm test`
