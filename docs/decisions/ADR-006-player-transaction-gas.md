# ADR-006: Gas for the transactions a player signs

**Status:** Accepted (OD-220 → Option B, 2026-10-27; OD-700 → top up to ≈ 1.5 NEAR, 2026-10-28)
**Date:** 2026-10-27
**Deciders:** the user

## Context
The player's only signed transaction in `add-feeding` is a feeding portion in NEAR (0.01 / 0.05 / 0.2 NEAR — OD-211); `add-gift` adds the gift (1 yocto). The user's accepted default: the project pays players' account creation and gas (PRODUCT.md › User Decisions, Product defaults). Facts (`near-contract`, `web-client`, checked 2026-10-27, volatile):
- Privy supports NEAR at Tier 2: it signs a raw hash, does not broadcast and sponsors no gas. Whether `signRawHash` can sign a NEP-366 `DelegateAction` is undocumented.
- Gas is bought up front at ≥ 0.001 NEAR/Tgas and the unburned part is refunded: a sender needs ~10× the burned gas in balance. A feeding call is a few Tgas [hypothesis: ~5 Tgas → ≈ 0.005 NEAR up front, ≈ 0.0005 NEAR burned].
- A meta-transaction relayer pays the gas **and every attached deposit** of the inner actions out of its own NEAR.
- A function-call key cannot send NEAR; the server key (ADR-002) is a function-call key on the contract only.
- The player's implicit account is created by the first transfer into it, and the sender pays the 0.007 NEAR (nearcore 2.13). A player who adds NEAR from an exchange or another wallet (OD-210) already has an account; feeding in NEAR never needs the project to create one.

So the only gap is a player whose wallet holds the portion but not the gas on top of it.

## Rejected: a relayer (NEP-366)
The relayer would pay the feeding deposit itself: the friend's NEAR would never move, the project would pay every meal, and the demo's «friend with NEAR, a real transfer» (critic MINOR 17) would be false. On top, Privy's delegate signing is undocumented.

## Options Considered

### Option A: a capped top-up method in the contract, paid from the project pool
| Dimension | Assessment |
|-----------|------------|
| Complexity | Medium — a new contract method with a per-day cap and its tests |
| Cost | ≈ 0.005 NEAR per player whose wallet lacks gas [hypothesis], mostly unburned and left in the player's wallet for later feeds (no withdrawal — OD-212) |
| Stolen server key | ≤ the daily cap × the amount, paid to accounts the thief names [hypothesis: 50 × 0.005 ≈ 0.25 NEAR ≈ $1.15 a day] until the key is revoked |
| Keys in the Worker | none new |
| What is public | a transfer from the contract to the player's account |

### Option B: a separate gas account, its full-access key a Worker secret
| Dimension | Assessment |
|-----------|------------|
| Complexity | Low — one transfer from the Worker, no contract code |
| Cost | as A |
| Stolen key | ≤ the gas account's balance, once [estimate: ≈ 1.5 NEAR ≈ $6.9 after OD-700; ≈ 0.5 NEAR ≈ $2.3 covered ≈ 100 feeding top-ups alone]; births, debits and snacks are untouched |
| Keys in the Worker | one more, full access, on an account holding only this money |
| Runs dry | top-ups stop until the user refills it; a player whose wallet lacks gas sees «You need a bit more NEAR» |
| What is public | a transfer from the project's gas account to the player's account |

### Option C: the player pays gas from their own NEAR
| Dimension | Assessment |
|-----------|------------|
| Complexity | None |
| Cost | $0 for the project |
| What the player sees | a portion needs its price plus ≈ 0.005 NEAR in the wallet [hypothesis]; ≈ 0.0005 NEAR more leaves the wallet than the portion says |
| Decision | reverses the accepted default «project pays players' gas» |

## Trade-off Analysis
A and B both keep the user's default and bound a theft to about a dollar or two; A bounds it per day inside the contract at the cost of contract code in a 14-day build, B bounds it by a balance at the cost of one more full-access key and one more balance to watch. C costs nothing and adds no keys, but a player who adds exactly the portion cannot feed, and the wallet moves by slightly more than the portion.

## Recommendation
Option B — the smallest build, the smallest total a thief can take (the balance, once), and no change to the contract, the server key or the pool. Volatile: Privy's NEAR tier, the gas price floor, the protocol votes of 2026-11-04/06.

## Decision
Option B (the user, 2026-10-27: «Газовый аккаунт проекта»): a separate project account holding ≈ 1.5 NEAR [estimate] (≈ 0.5 NEAR at first; topped up for gifts — OD-700, the user, 2026-10-28: «Пополнить до ≈1.5 NEAR») tops up gas for a feeder whose wallet lacks it, and the gas, 1 yocto and account creation of a giver (ADR-014); its full-access key is a Worker secret; the player notices nothing. The contract, the pool and the server key are unchanged.

## Consequences
- The server tops up only a wallet holding the portion but not its gas, and only once per player (add-feeding critic MINOR 6, the user, 2026-10-27); the top-up is a public transfer from the gas account (PRODUCT.md §8, `Feeding gas data`). A player who already got it and lacks gas again sees the gas in the missing amount: Feed sheet › «мало NEAR», or «без NEAR» when the wallet holds only what is left of the top-up (add-feeding critic MAJOR 1, the user, 2026-10-30: «Сразу «Add 0.02 NEAR»»; `Player wallet data`), so one transfer is enough.
- The browser signs only one action — `pet_feed` on the pets contract for the pet on the screen, with the deposit of the tapped portion — whatever the server sends (add-feeding critic MAJOR 3, the user, 2026-10-27: «Браузер сверяет»; the pet check — add-feeding critic MAJOR 3, the user, 2026-10-28: «Да, сверять питомца»; `Feeding transaction data`). This guards against a tampered server response, not against tampered client code.
- The gas account below one top-up stops top-ups until the user refills it; a player whose wallet lacks gas sees Feed sheet › «мало NEAR».
- A stolen gas-account key takes at most its balance, once: ≈ 1.5 NEAR ≈ $6.9 [estimate] instead of ≈ $2.3 before OD-700.
- A failed feeding burns its gas from the player's wallet: that is the gas the project added.
- `add-gift` reuses the same path for the gift's gas, 1 yocto and the creation of a giver's account (ADR-014) — also once per player, separate from the feeding top-up (add-gift critic MINOR 7, the user, 2026-10-28).
- A wallet holding no more than the gas the project added reads as «no NEAR» in feeding (add-feeding critic MAJOR 2, the user, 2026-10-28; `Player wallet data`). Feeding top-ups (≤ ≈ 0.25 NEAR) and gifts (≤ ≈ 1.2 NEAR at 100 givers) fit in ≈ 1.5 NEAR [estimate: PRODUCT.md §4 › Траты проекта], so neither pauses the other during the playtest.
- On any service pause (`Service pause data`) portions still go through: their gas is not the server account's.

## Action Items
1. [x] The user picks A, B or C (OD-220) — B, 2026-10-27.
2. [x] The user sizes the gas account for gifts (OD-700) — ≈ 1.5 NEAR, 2026-10-28.
3. [ ] Re-check Privy's NEAR tier and the gas price floor before the build.
