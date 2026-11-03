# ADR-028: Reserve linked food for one shared errand

**Status:** Accepted (the user, 2026-11-03, OD-1931 and the 2026-11-03b critic resolution)
**Date:** 2026-11-03
**Deciders:** the user

## Context

Ordinary `debit_session` spends project food before given food. A friend's meal or project snack linked to a job would otherwise unlock it while older food paid. The user chose linked food first and a way for the owner to close an abandoned waiting job. A stolen server key must not free its reserve before settlement.

## Decision

One active random job hash per pet lives on chain with a fixed allowance no greater than 0.005 NEAR, funding/running/transferred/settled state, and linked NEAR and snack balances. The allowance is the job's full ceiling for up to three searches, independent of current pet food. The server opens the job with `shared_job_open`; `pet_feed` and `pet_snack` accept its hash only while funding, and only a non-owner may sponsor. Ordinary spends cannot consume the reserve. `shared_job_start` requires the recorded allowance and freezes funding. A running job's one `debit_session` spends linked NEAR meals, then linked snacks, then ordinary food; after a gift, linked food only. Its public receipt records the amount used from each funding transaction. The contract cannot verify the words or that a model ran.

A paid outcome is debited immediately so the server can close the settled reserve before another job opens. `shared_job_close` releases unused food to the pet's ordinary buckets and returns the bounded record's stake to the project pool; sponsors receive no refund. The server may close a settled job alone. An unsettled job needs the current owner's signed close intent bound to the contract, pet and job hash, verified on chain. Ordinary closure is offered while waiting or after a run with no paid call. Memory clear uses the same owner approval when the reserve is unsettled. On gift, `nft_transfer` closes a waiting job; a running reserve stays for its one debit or a later close approved by the new owner. If memory was cleared before that gift, the surviving D1 close record contains no words; the former owner's signature becomes invalid, and the new owner can release the reserve with one signed tap. A debit confirmed first spends linked food only; a debit submitted after close fails without spending. The old link closes on gift or memory clear. A paid report follows the pet under «Previous owner» only if its words still exist. The job words and link code stay off chain; hash, allowance, states, funding events, debit source amounts and any close signature are public for good.

## Options considered

### A. Linked food only unlocks the job

No contract change or new storage. Existing project-first debit can spend older food, so the public receipt cannot show the friend paying for the promised job.

### B. Reserve linked food on chain (chosen)

Extend feeding and debit and add open/start/close. The sponsor sees linked food pay first. A paid job may add one debit transaction (≈ 0.23¢ gas minus ≈ 0.06¢ gas share = ≈ 0.17¢ project gas at PRODUCT.md §4's estimate), plus open/start/close gas and refundable stake. Exact gas and stake need a build measurement. Owner approval adds a signature and on-chain verification gas.

### C. Reserve only in D1

No new chain state. A stale or stolen server can spend another bucket, and an observer cannot verify the attribution.

## Consequences

- Feeding and `debit_session` need a contract upgrade and state migration before linked funding goes live (ADR-003).
- The project accounts for immediate debit and close gas; product-lead updates §4 after measuring signature verification, open/start/close and stake.
- A stolen server key can open and start jobs, and debit linked food once to the treasury under ≤ 0.005 NEAR per thought and ≤ 0.05 NEAR per pet per UTC day. It can close a settled job but cannot free an unsettled reserve without owner approval or the waiting-job gift path.
- `near-contract` › For the spec supplies caller checks, public event and refundable storage-stake facts; the gas share is an estimate, not a protocol constant.
