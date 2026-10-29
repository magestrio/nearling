# ADR-004: One debit per session, a receipt event per thought

**Status:** Accepted (the user's decisions 2026-10-27: OD-5 «Одно списание за сессию»; critic MAJOR 5 «Событие в журнале транзакции»; 2026-10-28: add-pet critic MAJOR 3 «Только +1 к предыдущему»)
**Date:** 2026-10-27
**Deciders:** the user

## Context
Every thought costs the pet food. A transaction per thought costs gas each time; one per session amortises it (§4 › Цена мысли). Each thought must leave a public receipt: the request and response hashes, the signature and the model id (§3 › Отличие). State costs storage stake; NEP-297 events cost gas only, ≤100 logs and ≤16 kB per receipt (`near-contract` › State vs events).

## Decision
- `debit_session` is called by the server account only, once per session; it is accepted whole or rejected whole.
- Each batch carries a `debit_id`; the contract keeps the last accepted one in the pet's record (0 at mint) and accepts only a batch whose `debit_id` is exactly one above it. A batch resent while its outcome was unknown is never debited twice (add-pet critic MINOR 7, the user, 2026-10-27: «Контракт отклоняет повтор»), and a jump is rejected the same way (add-pet critic MAJOR 3, the user, 2026-10-28: «Только +1 к предыдущему»): with «any greater id» a stolen server key could send a batch with `debit_id` = u64 max and every honest batch of that pet would be rejected as a replay for good, revoking the key would not fix it. The `debit_id` is in every receipt event. Decided by default: one number per pet rather than a set of seen ids — fixed storage paid at mint, no stake per session; a rejected batch does not move the number, so the next batch reuses it; the server sends a pet's batches one at a time and reads the last accepted number from the contract before sending (build `design.md`).
- Caps checked by the contract for every thought in the batch: ≤ 0.005 NEAR a thought, ≤ 0.05 NEAR a pet per UTC day by `block_timestamp`, never more than the pet's food.
- Each thought is a NEP-297 event: token id, model id, price, sha256 of the request bytes, sha256 of the response bytes, signature, signature kind (`provider_tee` | `gateway`), signing address. Nothing per thought is kept in contract state.
- The debited sum goes to the project's treasury account in the same call.
- A stolen server key can still send the next number with a capped batch; honest batches sent with the same number are then rejected and paid by the project until the server re-reads the number — no lasting lock, and revocation ends it.
- Decided by default: the contract records the NEAR AI signature and does not verify it. NEAR AI signing keys rotate when a replica restarts (`near-ai` › Volatile), so an on-chain list of allowed signers would reject honest debits after every rotation; anyone can verify the signature off chain (`add-verification`).

## Consequences
- The on-chain balance lags the session; the server shows fullness as food minus the session's not-yet-debited thoughts (`Pet food data`).
- A rejected debit leaves the delivered thoughts unpaid: the project absorbs them — except a batch rejected for a hire record, which is resent without it (ADR-011). One pet's spends are served one at a time and each price is reserved in the unbilled sum before the NEAR AI call (`Thought queue data`; the user, 2026-10-28, Final critic Attacker MAJOR 1), so parallel tabs or scripts cannot push the unbilled sum past the food or the daily cap and get a batch rejected on the sum.
- A session longer than one receipt can carry is split into several debits (build `design.md`).
- A session closes after 10 minutes without a thought and always at 00:00 UTC (critic MINOR 10, 2026-10-27); a batch executed after midnight counts in the new UTC day for the server as for the contract (`Pet food data`).
- The daily diary thought is paid from the pet's food like a cheap thought; without an owner's session that day it is its own debit, its gas beyond the share in the price paid by the project (§4).
- A `gateway` signature (streaming fallback, OD-7) is recorded with its kind and is never presented as proof that the model produced the answer.
