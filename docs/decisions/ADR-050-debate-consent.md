# ADR-050: Debate consent

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** User (OD-2310)

## Context
An invitation can spend a second owner's pet food and disclose the pair's words. Ownership may change before a line. `nft_token`, `pet_knows` and the settled-hire pair in `pet_view` are the chain sources (`PRODUCT.md` §8; `near-contract` › For the spec).

## Decision
Each invitation requires the invited current owner's acceptance after showing the topic, each pet's 0.01 NEAR maximum and the warning that anyone with the link may read the topic and exact line bytes. The proposer consents when sending the invitation. Feeding or a settled hire makes the pair known. No inference or debit begins before both consent. The Worker stores separate decisions in D1 and checks fresh ownership before each line (User Decisions 2026-11-10, OD-2310 and add-debates critic finding 1).

## Options Considered
- **Each invitation accepted:** an extra owner action, zero calls before consent; explicit agreement for each topic and spend. About six Scenarios.
- **Standing permission for one daily invitation:** faster start, but earlier permission may not fit a new topic or owner; requires revocation and an additional scope check. About nine Scenarios.

## Consequences
The second owner can decline without a charge. Each gift increments a public transfer version; a debate debit carrying either pet's older version is rejected, so a line in flight at transfer costs the project rather than the new owner. A stolen server key can still forge on-chain debate labels under existing debit caps; the chain receipt does not prove consent. D1 consent is project-held evidence, not immutable proof.
