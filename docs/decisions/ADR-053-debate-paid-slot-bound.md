# ADR-053: On-chain bound for debate lines

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** User (OD-2330)

## Context
The accepted payment is at most two 0.005 NEAR thoughts per pet per debate, but the existing `debit_session` contract only limits total debits to 0.05 NEAR per pet per UTC day. Without a debate-specific bound, a stolen server key could submit more debate-labeled receipts inside that cap (`PRODUCT.md` §4, §8; `near-contract` › The caps).

## Decision
The contract stores a fixed per-pet slot holding occupied UTC day, paid debate id, lifetime accepted count and used line-order bits. `debit_session` updates it only on accepted debate thoughts and rejects a third line across days, more than 0.01 NEAR of debate debits per UTC day, duplicate order or another paid debate id that day. An unfinished debate keeps its id and count across midnight; its next paid line occupies the new UTC day. The state and old receipt metadata are public; the contract does not assert that both owners consented. Slot storage is measured in the build (User Decisions 2026-11-10, OD-2330 and add-debates critic finding 4).

## Options Considered
- **Contract bound:** an attacker with the server key can charge at most 0.01 NEAR per pet for debate-labeled lines that day; fixed extra storage stake per pet and about five extra Scenarios. Exact bytes and stake need measurement; NEAR storage costs 1e19 yocto per byte (`near-contract` › What it costs).
- **Worker bound only:** no new chain state or storage cost; honest flow still stops at two lines, but a stolen server key can charge up to the existing 0.05 NEAR daily cap with fabricated debate labels.

## Consequences
The slot begins on a pet's first accepted paid line. A pet that has not paid remains subject to the Worker's one-started-debate rule, including the day an earlier debate carries across midnight. A new debate can start after the next reset following that debate's end. The chain cannot prove that no second unpaid invitation occurred. No new contract method or deposit is needed. Full-access contract upgrade remains the owner's existing ADR-003 choice.
