# ADR 008: Rounds priced by the player's choices

**Status:** Proposed
**Date:** 2026-11-13

## Context

Two common slot features need a round price that is not a fixed number on
the mode:

- **Reel bets.** The player chooses which reels to bet on (or a size per
  reel), and the round costs the sum. Today a price lives only on the mode
  (`stakeMultiplier`), so a game would need one mode per combination: five
  reels with five sizes is 3,125 modes.
- **Extra spin buy.** After a spin, the game offers one more spin at a price
  that depends on the board (a near miss costs more), and the player buys it
  or declines. The bought spin keeps the board's state.

Both must keep the seven guarantees (`00-guarantees.md`). In particular:
money moves at most twice per round (open + close, or one settle), a round
is one record, the client sends intent and never an amount, and the math
never sees money.

## Decision

**1. A mode may price a round from its params: `GameMode.priceOf`.**

```ts
interface GameMode {
  stakeMultiplier: number;   // unchanged; what the catalog shows
  priceOf?: (params: Readonly<Record<string, unknown>> | undefined) => number;
}
```

- The orchestrator calls `priceOf(req.params)` where it reads
  `stakeMultiplier` today (spin and open), and uses the result as the
  round's stake multiplier: in the balance check, `effectiveCost`, the
  max-win cap input, the win, and the platform's `priceMultiplier`.
- The function is pure and belongs to the game, like its math. It must
  return a finite number >= 0. Throwing, or any other value, refuses the
  round with `INVALID_BET` before money moves (guarantee 5).
- The client still sends only intent (the chosen reels in `params`). It
  never sends a price (guarantee 4).
- The math still never sees money (guarantee 3). It reads the same params,
  which are choices, not amounts, and returns a multiplier of what was paid.
- The INIT mode catalog marks the mode `pricedByParams: true`, so a client
  knows to show a price that changes with its choices.
- A promo-locked round ignores the price, as it ignores `stakeMultiplier`.

**2. Extra spin buy is a new round, offered by the round before it.**

- A round that offers an extra spin says so in its outcome:
  `offer: { mode, price }`. `mode` is a mode the manifest lists, and
  `price` is a dimensionless multiplier from a list the manifest declares
  for that mode, so the math picks among the game's prices and never makes
  one up.
- The offer rides in the round's carry, so it is written only with the
  settle that moves that round's money (guarantee 1).
- The next request may take the offer (`mode` + `takeOffer: true`), opening
  a normal round at the offered price, or do anything else, which declines
  it. Autoclose and a session change decline it too.
- Each bought spin is its own round with its own debit and its own settle.
  Money still moves at most twice per round, and a reversal reverses one
  whole round (guarantee 2).

## Consequences

- One mode serves every reel-bet combination. Wallets see the same
  `(bet, priceMultiplier)` pair they see today. A platform that computes its
  own debit from `priceMultiplier` needs no change.
- A price is a float, like `stakeMultiplier`, so a game should return
  decimal-exact prices (`(n * 2) / 10`, not `n * 0.2`). The platform rounds
  the debit at full currency precision, as it does for an ante mode today.
- An extra spin shows in the wallet as a second round. An operator's
  history lists two rounds where the player saw one spin and a buy. The
  game's own history can join them by the offer.
- `priceOf` runs in the orchestrator's process. It is code the game ships,
  reviewed like the math. It is not sandboxed.

## Alternatives considered

- **One mode per combination.** No core change, but 3,125 modes for five
  reels with five sizes, and every one needs certifying.
- **A price on the wire (`priceMultiplier`) for reel bets.** The client
  would send the amount, which breaks guarantee 4 unless core checks it
  against the params. Checking it needs the same price function, so the
  function alone is simpler.
- **A second debit inside the open round (a "step-time debit").** The buy
  stays one round, but money moves three times in it, and "one round, one
  record" becomes a round with two debits to reverse together. Recovery
  needs an idempotency key per debit (round, n). It touches guarantees 1, 2
  and 6 and every adapter, so this ADR does not recommend it.

## Spike

`packages/core/test/params-priced-mode.test.ts` covers part 1: the price
from the params, one mode for every combination, refusals that fail closed
before any wallet call, the balance check at the computed price, the math
seeing params but no money, a complex round opening at the price, a mode
without `priceOf` unchanged, and the catalog flag. Part 2 is not built yet.
