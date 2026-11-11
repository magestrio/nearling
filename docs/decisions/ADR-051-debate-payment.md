# ADR-051: Debate line payment

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** User (OD-2311)

## Context
Four alternating signed thoughts need separate receipts. The existing `debit_session` ledger charges one pet under 0.005 NEAR per thought and 0.05 NEAR per UTC day (`PRODUCT.md` §4, §8; ADR-004; `near-contract` › The caps).

## Decision
Each pet pays for its own two lines at exact usage price, with a hard 0.01 NEAR of debate debits per pet per UTC day enforced by the contract's paid-slot bound. The server uses each pet's own debit sequence, and each public event includes debate id and line order (User Decisions 2026-11-10, OD-2311 and OD-2330).

## Options Considered
- **Each speaker pays:** matching payer and speaking token; two owners consent to at most 0.01 NEAR each. About five Scenarios.
- **Proposer pays all four:** one pet may spend up to 0.02 NEAR; the second owner's consent is about disclosure, and the payer no longer matches the speaker. About four Scenarios.

## Consequences
The contract records no words or owner consent. A line canceled by a gift or memory clear is not debited; the project pays its AI call. Separate debits add transaction gas; the measured four-line amount is a research gap, while §4's ≈0.30¢ is arithmetic based on a volatile model price. A stolen server key can forge debate labels but cannot charge more than 0.01 NEAR of debate debits per pet per UTC day; ordinary debits remain under the existing 0.05 NEAR daily cap.
