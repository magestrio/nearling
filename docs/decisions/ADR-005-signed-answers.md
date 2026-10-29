# ADR-005: Model-signed answers, streaming as the fallback

**Status:** Accepted (the user's decision 2026-10-27: OD-7 «Все мысли с подписью модели», with the day-4 fallback)
**Date:** 2026-10-27
**Deciders:** the user

## Context
A `provider_tee` signature — the model's own TEE signing `"<model_id>:<sha256(request)>:<sha256(response)>"` — exists only for NEAR-hosted Private TEE models, on a non-streaming request with the canonical model id and `x-no-aliasing: true`. A streamed answer gets a `gateway` signature, which "does not prove that an attested model generated them" (`near-ai` › Volatile, checked 2026-10-27). Beyond ~2 s the loop loses immersion (§4 › Задержка).

## Options Considered
- **Non-streamed, model-signed:** the receipt proves the model once its signer matches NEAR AI's attestation of that model — checked on NEAR AI's page, not by the receipt alone (ADR-018); the player waits for the whole answer.
- **Streamed, gateway-signed:** text appears at once; the receipt proves only the request and the response bytes passed the gateway.

## Decision
Every thought is non-streamed and model-signed with the two Private TEE models of §4 (`z-ai/glm-5.3-flash`, `Qwen/Qwen3.6-35B-A3B-FP8`; ids volatile, from `/v1/models`). If the median on build day 4 is above 2.5 s, ordinary thoughts switch to streaming and confirm only the character; «подумай как следует» and workers' answers stay model-signed.

## Consequences
- The receipt records the signature kind (ADR-004); the verification page never shows a `gateway` signature as proof of the model.
- Signing keys rotate: an old receipt can later fail to match a signer.
