# ADR-018: Attestation evidence after a signing-key rotation

**Status:** Accepted (OD-1081 → Option B, the user, 2026-10-28)
**Date:** 2026-10-28
**Deciders:** the user

## Context
Each receipt records the model's signature and the signer's address (ADR-004). The signature proves that the signer signed `"<model_id>:<sha256(request)>:<sha256(response)>"`; that the signer sat inside attested model hardware is proven by NEAR AI's attestation report, whose `signing_address` must match (`near-ai` › Signatures and attestation).

- NEAR AI signing keys rotate when a replica restarts; re-verifying an old receipt later can fail to match a signer (`near-ai` › Volatile, 2026-10-27).
- Evidence must be fetched before the completion: "A report fetched after the completion cannot replace this preflight evidence" (`near-ai` references › Signature and attestation).
- The public page `cloud.near.ai/verify?model=…#receipt=…` checks the hardware evidence fresh in the browser; its receipt fields are `completionId, model, signatureKind, signingAlgo, signingAddress, signedText, signature, verifiedAt?` — no stored report (same source).
- `add-verification` has a Scenario «ключ подписи сменился», which needs the page to know the current signers.

## Options Considered

### Option A: Keep the report of each signer
| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: a preflight attestation fetch with a fresh nonce before completions, the report kept in D1 by signer address, compared with today's report when the page opens |
| Latency | One more request before a thought — per thought for strict preflight, or once per new signer for a weaker one ? [gap: latency] |
| What the viewer can verify | After a rotation, the stored report still shows the signer was in attested hardware — checkable by a verifier such as `nearai-cloud-verifier`, not by NEAR AI's public page |
| Data | Server → NEAR AI attestation endpoint, no player data; the report is public evidence |

### Option B: Keep nothing
| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Latency | None added |
| What the viewer can verify | The signature, forever, against the address on chain — that this key signed the hashes, not whose key it is; the hardware only fresh on NEAR AI's page, which after a rotation says itself that the signer cannot be matched |
| Data | Nothing new |

## Trade-off Analysis
A keeps a hardware proof alive after rotations at the price of a request before thoughts against the ~2 s budget (§4 › Задержка) and a check that NEAR AI's public page can't run. B keeps latency and the build small; a judge who checks fresh thoughts on a demo pet the same day meets a rotation only if a replica restarts in between [hypothesis].

## Recommendation
Option B — the judge's path is fresh thoughts on a demo pet (§4 › Демо-момент), the signature itself stays checkable for good, and A's preflight costs latency the loop doesn't have. Volatile: key rotation frequency (`near-ai` › Volatile).

## Decision
Option B (the user, 2026-10-28: «Не хранить, строка у ссылки»). No attestation report is kept; the signature stays checkable for good against the signer address on chain, the hardware only fresh on NEAR AI's page. The address on chain is whatever the server's key recorded (`debit_session` doesn't check the signature), and a `provider_tee` signer counts only when it matches exactly one verified model report (`near-ai` › Pitfalls) — so our page's mark is «Signed by key {signer}», never «signed inside the model's hardware» (critic BLOCKER 1 → «Честная отметка», the user, 2026-10-28).

Facts (`research/gap-near-ai-attestation-over-time.md`, 2026-10-28): `/v1/attestation/report` needs an API key (401 without one), so the viewer's browser can't learn today's signers itself; no rotation schedule is documented — keys change when a replica restarts — **volatile**; the latency of a keyed report fetch was not found — **volatile**, re-checked before the build (the user, 2026-10-28).

## Consequences
- Our page can't detect a rotated key: the Scenario «ключ подписи сменился» is gone, and a permanent line stands by «Check the hardware on NEAR AI» (`Verification flow` › «аппаратная проверка»); it no longer says the signature here still checks out — a signer NEAR AI's page can't find is unproven hardware.
- §8 › «Указатель чека» keeps no report; no new entity, no request to NEAR AI before a thought.
