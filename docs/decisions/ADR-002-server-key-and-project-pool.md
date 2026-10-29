# ADR-002: The server's NEAR key and the project pool in the contract

**Status:** Accepted — function-call key without an allowance (OD-91, the user's decision 2026-10-27: «Без лимита газа»); the project pool decided by default and accepted («Принимаю все»); the starter food a birth takes from the pool is 12 cheap thoughts (OD-1310, the user, 2026-10-28)
**Date:** 2026-10-27
**Deciders:** the user

## Context
The Worker sends the birth (`pet_mint`) and the session debit (`debit_session`); the player signs neither (PRODUCT.md §4, OD-5). A function-call key restricts the key, not the method: the contract checks that the caller is the server account and enforces the caps. A function-call key — plain or gas key — cannot attach NEAR (`near-contract` › For the spec, facts §2). A stolen server key must not be able to empty pets or the project.

## Decided by default: the project pool
Because no function-call key can attach a deposit, the mint cannot be paid by the server's attached deposit. The contract keeps a project pool in its own balance: the user funds it, `pet_mint` takes the starter food and the new pet's storage from it. The alternative — a full-access key in the Worker — would put the whole server account within reach of a thief. The pool is the bound of what a stolen key can spend on births.

## Options Considered (the key type — OD-91)

### Option A: Function-call key without an allowance
| Dimension | Assessment |
|-----------|------------|
| Gas | paid from the server account's balance, no limit on the key |
| Failure | never dies by itself |
| Parallel debits | one nonce sequence per key; several keys if needed |
| Tooling | every NEAR SDK |

### Option B: Function-call key with an allowance
| Dimension | Assessment |
|-----------|------------|
| Gas | at most the allowance |
| Failure | "When exhausted the key is unusable … can't be raised, only replaced" — births and debits stop until the user adds a new key |

### Option C: FunctionCall gas key (NEP-611, protocol 86)
| Dimension | Assessment |
|-----------|------------|
| Gas | from the key's own prepaid balance |
| Parallel debits | up to 1,024 nonce lanes |
| Failure | remaining balance is burned on delete; delete fails if more than 1 NEAR would burn |
| Tooling | near-cli, near-kit; new (nearcore 2.13) |

## Trade-off Analysis
All three are bounded by the same contract caps: the key type changes only how much gas a thief can burn and whether the game can stop by itself. A bounds gas by the server account's balance, which holds only gas money; B bounds it tighter but can stop births and debits mid-playtest; C gives parallel nonces the playtest (≤ ~150 players) does not need and burns its balance when revoked.

## Recommendation
Option A — it never stops the game by itself, the gas a thief can burn is bounded by the small balance of the server account, and it works with every SDK.

## Decision
Option A (OD-91, the user, 2026-10-27). The server account holds only gas money; the user tops it up by hand. When it is down to the reserve that debits the sessions not yet debited, the server pauses births, snacks and new thoughts until the top-up (critic MAJOR 4, the user, 2026-10-27: «Всё на паузе с текстом»; `Service pause data`).

## Blast radius (any option)
- Debits: min(pet's food, 0.05 NEAR) × pets per UTC day, paid to the project's treasury, never to the thief (§4 › Лимиты).
- Births: at most 50 per UTC day by `block_timestamp` (OD-100, the user, 2026-10-27) — ≈ 50 × 0.0326 NEAR (≈ 0.03 storage + ≈ 0.0026 starter food, 12 cheap thoughts — OD-1310, the user, 2026-10-28) ≈ 1.63 NEAR (≈ $7.5 at NEAR ≈ $4.59, volatile) of the pool a day — never more than the pool, one born pet per receiving account. The 0.0326 NEAR holds only because `pet_mint` rejects a character longer than the longest assembly of the presets (add-pet critic MAJOR 2, the user, 2026-10-28): without that cap one call with a huge character could lock the whole pool in storage.
- Gas: up to the server account's balance.
- Revocation: the user deletes the key from the server account with that account's full-access key; it stops at the next block.

## Amendment, 2026-10-29 — numbers from usage pricing
The thought is paid by usage since 2026-10-29 (the user, Init fix: «Да, платит по факту»; ADR-004 › «Paid by usage»), and §4 now measures food in typical thoughts ≈ 0.076¢. The starter food stays 12 thoughts (OD-1310): ≈ 0.0020 NEAR (was ≈ 0.0026). A birth takes ≈ 0.032 NEAR of the pool (was ≈ 0.0326), so the birth bound of a stolen key is ≈ 50 × 0.032 ≈ 1.6 NEAR ≈ $7.3 a day (was ≈ 1.63 NEAR ≈ $7.5) [estimate: arithmetic, §4 › Лимиты › Рождения; NEAR ≈ $4.59, volatile]; the pool of 4.9 NEAR still holds ≈ 150 births. The debit bound — min(food, 0.05 NEAR) × pets a day — and the key type are unchanged; the contract takes any per-thought price up to 0.005 NEAR, as before. The figures in «Blast radius» above are kept as written on 2026-10-27/28.

## Action Items
1. [x] The user picks the key type (OD-91) — without an allowance, 2026-10-27.
2. [x] Product-lead: whether the contract also caps births per UTC day — 50 a day (OD-100, the user, 2026-10-27).
