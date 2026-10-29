# ADR-011: What a hire records on chain, and who pays the acquaintance it makes

**Status:** Accepted (2026-10-28: the defaults «Принимаю все»; OD-500 → «Пул без предела», Option A; add-pet-work critic MAJOR 1–4, 2026-10-28)
**Date:** 2026-10-28
**Deciders:** the user

## Context
A pet pays another owner's pet a fixed fee for an answer — advice asked by a player, or a hire the pet decides on itself (PRODUCT.md §4 › Работа для других; OD-10, OD-11). The contract, not only the server, checks the fee, ≤ 10 jobs a day per worker, known pets only and no hire between one owner's pets (critic MAJOR 7a). §4 puts the fee and the earning into the hirer's session debit. Each thought already leaves a receipt event in `debit_session` (ADR-004). The worker answers with a model signature, never a stream (§4 › Задержка). Pets met through feeding are known by the feeder's account (`Pet feed contract`, `Pet snack contract`, ADR-007); pets met through work must become known too, both ways after advice (`Known pets rule`). State costs storage stake — ≈ 0.0011 NEAR per record [estimate: `near-contract` › What it costs]; events cost gas only, ≤ 100 logs and ≤ 16 kB per receipt.

## Decision
Accepted by the user as proposed (2026-10-28, «Принимаю все»):
- A hire is an entry in the hirer's `debit_session` batch: worker, kind (`player` | `pet`), fee, the worker's answer cost and receipt. The batch stays all-or-nothing; one transaction carries the fee, the earning and the worker's receipt, so no extra gas per hire.
- The worker's answer is paid out of the fee: the worker's given food gets fee − answer cost, the treasury gets the answer cost. The worker never goes below zero for a job and its own daily cap is untouched; the hirer's daily cap and food carry the whole fee.
- The contract checks: fee = the hire fee, a constant in its code with no method to change it; the fee counts with the batch's thoughts in the hirer's daily cap and «no more than its food» (`add-pet` › `Session debit contract`); answer cost < fee; different owners; ≤ 10 accepted jobs per worker per UTC day by `block_timestamp` (a counter in the pet record, inside the storage paid at mint); for `pet` — the worker is known and the fee comes from given food only (OD-491 → «Нет, как в Auto»).
- Event `hire` {debit_id, hirer, worker, kind, fee, answer cost} plus the worker's receipt with the worker's token id. The kind is public: README splits player- and pet-initiated hires (the user's defaults, 2026-10-27). No question, no answer, no memory on chain.
- A pet met through work is recorded as one pair record {lower token id, higher token id}, read both ways — half the stake of a record on each side. It stays with the pets on a gift.
- Hire mode and the pending Manual offer live in D1 by token id and go with the pet on a gift: switching the mode costs no gas and changes nothing public.
- The pet decides to hire, and writes the question, in the same model call as its ordinary answer — no separate decision call (critic MAJOR 2 → «В том же вызове, что ответ», 2026-10-28). That call is whole and model-signed like every thought (OD-7) but has no receipt of its own: its bytes and signature stay with the hirer in D1, and the question it wrote is part of the worker's request, under the worker's receipt.
- The hirer's ordinary call carries only the characters and token ids of eligible known pets, never their names (critic MAJOR 3 → «Только характеры, без имён», 2026-10-28): names are written by players, characters are assembled by the server from presets, so no player text reaches the hire decision.
- At most 3 eligible known pets a turn (post-CLOSED critic MAJOR 2 → «Не больше 3 за ход», 2026-10-29), drawn at random among the eligible each turn (tech-architect default, open to the user's veto; the alternative — the 3 most recently met — favours the friend who just fed and a cacheable prompt prefix, but never again offers older acquaintances). A character is ≤ the longest preset assembly (≈ 2.4 KB ≈ 600 tokens [hypothesis: ~4 characters a token]), so the turn grows by ≤ ≈ 1,800 input tokens ≈ $0.00015 on `z-ai/glm-5.3-flash` at $0.08 per 1M input (volatile, near-ai › Models and prices) — inference stays under half the cheap thought's price.
- The pairs are read by the server from `pet_view` (`add-verification` › `Pet view contract`) before a hire, with the known feeders from the same pet record (post-CLOSED critic MINOR 5 → «Читает из контракта», 2026-10-29).
- The worker's answer is a cheap-model thought (`z-ai/glm-5.3-flash`) capped at 400 output tokens like every thought (`add-pet` › `Thought request data`).
- The worker's request carries no memory, so no names of earlier hirers (OD-492).

OD-500 → «Пул без предела» (Option A): the pool pays the pair record, every accepted hire makes the pets known, no per-day pair cap.

Critic MAJOR 4 → «Только обновлением кода» (2026-10-28): there is no settings method for the fee; it changes only by a contract upgrade with the user's full key (ADR-003), visible in the published, verified code.

## Options Considered

### Option A: the pool pays, no extra cap
| Dimension | Assessment |
|-----------|------------|
| What the player sees | nothing; a pair is known after any accepted hire |
| Project cost | ≈ 0.0011 NEAR (≈ 0.5¢) per new pair, locked for good; ≈ 100 pairs in the playtest ≈ $0.5 [hypothesis] |
| Stolen server key | ≤ 10 new pairs per pet a day (the job cap) → ≤ 0.011 NEAR per pet a day; 100 pets ≈ 1.1 NEAR ≈ $5 a day of the pool locked [estimate: arithmetic, NEAR ≈ $4.59] |
| Pool empty | the hire is accepted without the record |
| Spec | +1 Scenario (`Known pets contract` › «пул не покрывает знакомство») |

### Option B: the pool pays, ≤ 3 new pairs per worker per UTC day
| Dimension | Assessment |
|-----------|------------|
| What the player sees | nothing; the 4th new pair of a worker that day stays unknown until a feeding or another hire |
| Project cost | as A in the playtest |
| Stolen server key | ≤ 0.0033 NEAR per pet a day; 100 pets ≈ 0.33 NEAR ≈ $1.5 a day [estimate] |
| Pool empty | as A |
| Spec | +2 Scenarios (pool empty; over the per-day pair cap) and a per-day counter in the pet record |

## Trade-off Analysis
A keeps one rule — every accepted hire makes the pair known — at a thief bound of ≈ 1.1 NEAR a day at 100 pets, the same order as the accepted birth bound (≈ 1.63 NEAR a day, OD-100, OD-1310); both drain the same pool, and an empty pool closes births (`birth_blocked {reason: pool}`), so the user notices within the day and revokes the key (ADR-002). B cuts the thief bound by ~70% at the cost of a second counter and a case where a popular pet's advice on a viral day does not introduce the pets.

## Recommendation
Option A — one rule, the drain is bounded by the job cap and the pool, and it is of the same order as the birth bound the user already accepted.

## Consequences
- §4 › Траты проекта gains a line for work acquaintances (≈ $0.5) and §4 › Радиус взрыва the pool bound above (handover to product-lead).
- A batch rejected because of a hire record is resent at once with the same `debit_id` without that record and its receipt: the hirer's thoughts are debited, the worker's answer is paid by the project, the worker's not-yet-debited earning and work record are withdrawn (`Hire food data` › «повтор без найма»; the user, 2026-10-28, Final critic Attacker MAJOR 1 → «Повтор без плохой записи + очередь»). If the worker's own batch spent that earning and now exceeds the worker's food, the contract rejects it (`Session debit contract` › «больше еды питомца») and the server resends it with the same `debit_id` without the last thoughts the food doesn't cover; the project pays those, at most one withdrawn earning (≈ 0.4¢: fee ≈ 0.5¢ minus the answer ≈ 0.1¢, §4) per broken hire (`Hire food data` › «пачка работника без заработка»; the user, 2026-10-28, Final critic Attacker recheck MAJOR 1 → «Повтор пачки работника без мыслей без еды»). A player who forces the rejection on purpose — gifting the worker to the hirer's account inside the session window — gains one free worker answer and at most one earning's worth of the worker's thoughts per gift, never the whole batch. A batch rejected for any other reason is paid by the project.
- The server sends a worker's own batch that spends a not-yet-debited earning only after the hirer's batch with that hire (build `design.md`).
- Changing the hire fee between playtest days is a contract upgrade by the contract account's full key (the user's, ADR-003), made while no batch with the old fee is pending; a batch with the old fee is rejected and paid by the project. The source is re-published and verified after the upgrade (NEP-330).
- Advice is the paying pet's thought: on a gift it goes with the pet, and its new owner sees the old owner's questions and answers (critic MAJOR 1 → «Честный текст, уходит с питомцем», 2026-10-28; the giver's notice is `add-gift`'s).

## Action Items
1. [x] The user picks A or B (OD-500) — A, 2026-10-28.
2. [ ] The publicity notice on Hatch screen names hires and the pets met through work (ux-architect, `add-pet` › Hatch screen).
