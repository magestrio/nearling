# ADR-011: What a hire records on chain, and who pays the acquaintance it makes

**Status:** Accepted (2026-10-28: the defaults «Принимаю все»; OD-500 → «Пул без предела», Option A; add-pet-work critic MAJOR 1–4, 2026-10-28); amended 2026-10-29 — the hire turn paid by usage (see «Paid by usage, 2026-10-29»); its point on the worker's earning — Accepted 2026-10-29 (OD-1521 → A, «Заработок — после записи в сети»); when the hirer's batch with a hire is sent — Accepted 2026-10-29 (OD-1550 → A, «Как любой разговор»)
**Date:** 2026-10-28; amended 2026-10-29
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
- At most 3 eligible known pets a turn (post-CLOSED critic MAJOR 2 → «Не больше 3 за ход», 2026-10-29), drawn at random among the eligible each turn (tech-architect default, open to the user's veto; the alternative — the 3 most recently met — favours the friend who just fed and a cacheable prompt prefix, but never again offers older acquaintances). A character is ≤ the longest preset assembly (≈ 2.4 KB ≈ 600 tokens [hypothesis: ~4 characters a token]), so the turn grows by ≤ ≈ 1,800 input tokens ≈ $0.00007 on `Qwen/Qwen3.8-27B` at $0.04 per 1M input [estimate: arithmetic; price — `near-ai` › Models and prices, 2026-10-27, volatile] (since the Init model change, 2026-10-29, ADR-005 › «Init check, 2026-10-29»; on `z-ai/glm-5.3-flash` it was ≈ $0.00015); the thought's price that covers it is §4's.
- The pairs are read by the server from `pet_view` (`add-verification` › `Pet view contract`) before a hire (post-CLOSED critic MINOR 5 → «Читает из контракта», 2026-10-29). The known feeders are not a list the contract gives: the server keeps them as an index in D1 and checks each candidate with `pet_knows`, so the chain stays the truth (add-feeding critic MAJOR 2 → «Вести в нашей базе», 2026-10-30; `add-feeding` › `Pet knows contract`).
- The worker's answer is a cheap-model thought (`Qwen/Qwen3.8-27B` with reasoning off, `chat_template_kwargs.enable_thinking=false`, since 2026-10-29 — ADR-005 › «Init check, 2026-10-29»; was `z-ai/glm-5.3-flash`) capped at 400 output tokens like every thought (`add-pet` › `Thought request data`).
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
- A batch rejected because of a hire record is resent at once with the same `debit_id` without that record (`Hire food data` › «повтор без найма»; the user, 2026-10-28, Final critic Attacker MAJOR 1 → «Повтор без плохой записи + очередь»; who pays the worker's answer — «Paid by usage» below). The worker's work record is withdrawn and its earning never arrives; the earning was never in the worker's fullness (OD-1521 → A, below), so a player who forces the rejection on purpose — gifting the worker to the hirer's account inside the session window — gains nothing at the project's cost. A batch rejected for any other reason is paid by the project.
- Changing the hire fee between playtest days is a contract upgrade by the contract account's full key (the user's, ADR-003), made while no batch with the old fee is pending; a batch with the old fee is rejected and paid by the project. The source is re-published and verified after the upgrade (NEP-330).
- Advice is the paying pet's thought: on a gift it goes with the pet, and its new owner sees the old owner's questions and answers (critic MAJOR 1 → «Честный текст, уходит с питомцем», 2026-10-28; the giver's notice is `add-gift`'s).

## Paid by usage, 2026-10-29
The user's decisions at Init fix (2026-10-29): «Да, платит по факту»; the defaults «Принимаю все 4» (the hirer's own reply after the worker is a second thought, the fee only for a hire that happened) and «Принимаю все 9» (the worker's answer fuse 400); OD-1502 → «Наниматель по факту». Numbers from PRODUCT.md §4 › Работа для других. The bullets above stand except where this section says otherwise; the 400-token cap «like every thought» and the «the project pays» of the rejected-hire consequence are replaced here.
- **The fee** is ≈ 5 typical thoughts ≈ 0.00083 NEAR (≈ 0.38¢), a constant in the contract's code as before [estimate: §4].
- **The hire turn is up to three thoughts, each by usage** (ADR-004 › «Paid by usage»): (1) the hirer's call that decides and writes the question — its own thought with its own receipt in the hirer's batch, its input carrying the ≤ 3 characters (≤ ≈ 1,800 tokens) paid as the hirer's input; (2) the worker's answer — the worker's receipt, with the worker's token id, in the hirer's batch; (3) the hirer's own reply after the worker, after «No thanks» in Manual, or after a hire that did not happen — a second ordinary thought. Before 2026-10-29 the decision call had no receipt: its cost sat inside the fixed price of the reply.
- **The worker pays its answer by usage out of the fee:** the answer cost in the `hire` entry is the worker's receipt price by its `usage`; the worker's given food gets fee − answer cost, as before. Its `max_tokens` = min(400, what the fee pays after the input and the gas share), so the contract's «answer cost < fee» holds by construction at any NEAR→USD setting; at typical input the worst answer is ≈ 0.14¢, leaving the worker ≥ ≈ 3 typical thoughts [estimate: §4]. The worker's own food and daily cap are untouched.
- **The hire record rejected (OD-1502 A):** the batch is resent at once with the same `debit_id` without the `hire` entry; the worker's answer the player already got stays in it as the hirer's thought, its receipt under the worker's token id, priced by usage and taken from the hirer's food (any food, project food first) — no fee, the worker earns nothing; its earning never arrives and no work record is written (since the re-gate fixes below; before them the record was withdrawn). The project no longer pays the answer.
- **The worker's earning after the hirer's batch (OD-1521 → A, the user, 2026-10-29, «Заработок — после записи в сети»):** the earning (fee − answer cost) enters the worker's fullness and pays its thoughts, hires and purchases only once the hirer's batch with that hire is recorded; until then the worker's fullness is its food on chain minus its own unspent spending. A rejected hire record thus withdraws an earning nobody spent: no batch of the worker exceeds its food, and the project pays nothing. This replaces the resend of the worker's batch without its uncovered last thoughts, paid by the project ≤ one earning per broken hire (2026-10-28, Final critic Attacker recheck MAJOR 1), and the ordering of the worker's batch after the hirer's. Cost: the worker's owner sees the pet fuller when the hirer's batch is recorded, not with the answer.
- **When the hirer's batch with a hire is sent (OD-1550 → A, the user, 2026-10-29, «Как любой разговор»):** like any session (`Pet food data`) — 10 minutes after the hirer's last thought, by 00:00 UTC at the latest, no extra transaction; a long conversation of the hirer delays the earning beyond the «≤ ≈ 10 minutes» the OD-1521 question estimated. The rejected option B — the batch no later than 10 minutes after the hire, the hirer's later thoughts in a new batch — cost one more debit, ≈ $0.0023 of gas [hypothesis: PRODUCT.md §4 › Одно списание за сессию], for the project, +~1 Scenario.
- **The UTC day of a work record** (tech-architect default, 2026-10-29): the day the hirer's batch is recorded by `block_timestamp`, as the contract's job counter and the `hire` event — a hire answered before 00:00 UTC whose batch is recorded after it lands in the new day (`Work record data` › «найм перед полуночью»). The diary line for yesterday thus never waits for a batch still pending.
- **Re-gate fixes (the user, 2026-10-29, «Исправить все как рекомендуешь»; add-pet-work MINOR 5–7, MAJOR 1):** the work record is written only once the hirer's batch with that hire is recorded — the worker's memory, diary line and talk of its work see only recorded hires, and a rejected hire record leaves no record to withdraw (`Work record data`); a sleeping worker whose recorded earning lifts its food above one typical thought wakes as if fed, and its first thought draws on that record (`add-pet` › `Sleep and wake flow` › «разбудил заработок», `pet_woke {via: work}`); the worker's request carries the length layer, as the pet's own (`Hire request data`); a failed worker call releases its reserve like the pet's own, its tokens are the project's, and an answer without a line counts toward the paying pet's three a UTC day, beyond which the paying pet pays it by usage (ADR-005 › «No line»).
- **Thief bound, numbers updated:** ≤ 10 fees ≈ 3.8¢ a day per worker into the thief's pet (was ≈ 5¢); births ≈ 1.6 NEAR a day (was ≈ 1.63, ADR-002 › amendment).

## Action Items
1. [x] The user picks A or B (OD-500) — A, 2026-10-28.
2. [ ] The publicity notice on Hatch screen names hires and the pets met through work (ux-architect, `add-pet` › Hatch screen).
3. [x] The user decides OD-1521 (the worker's spent earning after a rejected hire record) — A, 2026-10-29.
4. [x] The user decides OD-1550 (when the hirer's batch with a hire is sent) — A, 2026-10-29.
