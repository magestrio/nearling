# ADR-052: Debate transcript access

**Status:** Accepted
**Date:** 2026-11-10
**Deciders:** User (OD-2312)

## Context
A receipt publishes hashes and cost forever, but an independent visitor needs exact request and response bytes to hash. Debate words may be copied once shown, even if D1 later deletes them (`PRODUCT.md` §8; `near-contract` › What is public; `near-ai` › For the spec).

## Decision
After both owners expressly consent, anyone with the secret link may read the topic and exact request and response bytes for each settled line. The model prompt uses public character and life context, the topic and prior debate lines only; private memory, skills and notes never enter it. D1 holds active bytes and a secret fragment share code separate from the public debate id; the browser sends that code only in a fixed-path read body. Chain events hold id, line order and existing receipt data, never words or code (User Decision 2026-11-10, OD-2312).

## Options Considered
- **Link-readable words and exact bytes:** visitors can check each line; copied words cannot be recalled. About nine Scenarios.
- **Two-owner words, public hashes only:** narrower disclosure, but visitors cannot independently recompute the hashes. About six Scenarios.

## Consequences
Clear memory removes the active D1 record and share code; a later visit shows «This debate is no longer available.» and «Go home». A line in flight when memory is cleared is neither stored nor debited; its AI call costs the project. D1 Time Travel may keep deleted rows up to 30 days on Workers Paid (volatile; `cf-worker` › For the spec). NEAR AI does not state a content-retention duration (volatile; `near-ai` › For the spec). Previously copied words and chain receipts remain outside deletion. The existing signature-kind wording still applies: a gateway signature does not prove model authorship.
