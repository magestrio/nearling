# ADR-023: Where a private skill lives, and what a skilled answer keeps

**Status:** Accepted (the user, 2026-11-01: «Брать, цену задаёт игра», skills private and off chain, defaults accepted; OD-1770 → «Обычный сбой»; the storage plan as told to the user; the rest tech-architect defaults, open to the user's veto)
**Date:** 2026-11-01
**Deciders:** the user

## Context
An owner writes one private instruction (≤ 1,000 characters) and a public label (≤ 40) for a pet. The instruction shapes the pet's answers for others. Other players must not read it on a screen, on chain, in a public API or on the verification page, and a receipt is public for good: it holds the sha256 of the exact request bytes. The payer's full check of a receipt needs those bytes, and they would hold the instruction. NEAR AI gets the instruction in the request, and the asker's question reaches the model as is, so a retelling can be coaxed out. A skill is a stranger's text entering a turn of the paying pet, whose later calls can spend food on a hire.

The checks below were made on the built server: `server/src/prompt.ts` › `buildMessages` sends every earlier `thoughts` row of a pet with its words as history, up to the input of a typical thought, into each later call, the diary and the wake thought included.

## Decision
- **Storage.** The label in the clear and the instruction under AES-256-GCM in D1 by token id. Web Crypto of the Worker, a fresh 96-bit nonce on every write, one key as a Worker secret, the token id as additional data so a row can't be moved to another pet. A copy of the key stays with the user outside Cloudflare: losing it makes every skill unreadable.
- **Decrypted only in memory**, for the current owner's Skill sheet and the worker's request. A job row keeps the token id, never the text.
- **No request bytes.** The request of a skilled answer is never written to D1, for anyone. The receipt keeps the hash; the paying pet keeps the words and the reply's bytes. Nothing to leak, nothing to erase on a clear of the memory, nothing that outlives a forgotten skill.
- **A random value in the request.** The server adds 128 random bits to the JSON of a skilled request, in a field outside `messages`, and keeps them nowhere. Without it the hash is an offline oracle: the payer knows the question, the character is public, the layers come from a short list and the assembly code is public, so a short guessed instruction could be confirmed against the receipt. Inside `messages` the model could be coaxed into repeating it, so it stays out. The field NEAR AI accepts and the signature still matching is checked at build [unconfirmed].
- **The leak filter.** After the reply, before it is shown or stored, on the server, no model call. Both texts: NFKC, lower case, every run of signs other than letters and digits as one space. The reply is stopped if it holds 8 words in a row of the instruction, or all of an instruction of 3–7 words; an instruction of 1–2 words isn't checked, there is nothing to leak and a common phrase would stop honest answers. 8 words is about a clause: shorter runs appear by chance in an answer on the skill's own topic. It stops only a verbatim leak, as §4 says.
- **A stopped reply is a failed call** (OD-1770): not shown, not stored, no fee; it counts with answers without a line in the paying pet's three a UTC day; from the fourth the pet pays by usage and the receipt holds hashes only.
- **No memory, no hire.** A turn with a skilled answer writes no memory: that answer and the pet's own reply of that turn stay readable in the conversation but go into no later request, so hostile text can't reach a later call that may hire. Any worker's answer, with a skill or not, is followed by a call with no acquaintances. The answer of a pet without a skill stays in history: its request holds preset text and the payer's own question, no stranger's free text.
- **The hirer's call** holds a candidate's public character and its label, never its instruction. A candidate with no skill has no label, so a literal «labels only» would leave no way to pick it. A label is a stranger's text in a call that can spend: it goes as one quoted line of data; the worst a label worded as an order can do is win that pet one hire a turn, inside `Hire eligibility rule` and, in Auto, 0.00163 NEAR.
- **The seam for `add-pet-errands`:** one worker call path with the skill layer and a sources step, empty in `add-pet-work`.

## Options Considered

### Storage
| Option | Protects against | Cost | What the player sees |
|---|---|---|---|
| A. AES-256-GCM in D1, key as a Worker secret (chosen) | a dump or backup of D1 alone | Web Crypto, one secret to keep | nothing |
| B. Plain text in D1 | nothing | none | nothing |
| C. OutLayer TEE per run | our server too | ≈ 0.7–1¢ a run against a fee from 0.38¢ [the user was told, 2026-11-01] | a fee that doesn't pay for its own run |

A protects storage, not the running server: README › Known limitations says our server reads the skill.

### The payer's proof
| Option | What the payer can check | Cost |
|---|---|---|
| A. No request bytes, reply bytes kept (chosen) | the signature and the receipt; the reply against its hash, if ux takes the mark | 0 Scenarios of its own |
| B. Hidden prefix and SHA-256 mid-state | that the visible bytes are the tail of the signed request | see below |
| C. Full bytes to the payer | everything | the instruction leaks through the payer's own receipt |

**The mid-state idea, checked.** It works as arithmetic: SHA-256 is a chain of 64-byte blocks, so with the secret as a whole-block prefix the server can hand over the state after the prefix and the remaining bytes, and the browser finishes the hash. It costs more than it proves:
- It proves only that the bytes shown end the signed request, not how the model read them. The hidden prefix is free text and comes first: «ignore what follows» sits under the proof, and the prefix decides how the JSON tail parses.
- The instruction must come first in the request bytes, ahead of the sealed character, which reverses the order `Sealed character rule` stands on.
- The prefix needs the random value too: the mid-state confirms guesses faster than the hash.
- Web Crypto exposes no mid-state, so both the Worker and the browser need a hand-written SHA-256; +~3 Scenarios, and `Verification flow` › «skilled answer» changes.
Not built. It stays in IDEAS.md with this finding.

### The leak filter
A whole-instruction match misses a leak of one sentence. A check by a model call costs a call per answer and reads the instruction with one more model. A re-ask (OD-1770, rejected) adds a wait and a second call to a question built to draw the text out.

## Consequences
- A reply's input tokens in the public receipt show the instruction's rough length, not its words.
- The filter is also a small oracle: a question that asks the worker to repeat a guess of 8 words learns from the stop that it was right. It costs the asker three free tries a UTC day, then its pet's food by usage, and it finds less than a retelling.
- `buildMessages` must skip the rows of a turn with a skilled answer; `forgetStatements` deletes the skill row in the one batch.
- D1 Time Travel keeps a forgotten instruction's ciphertext up to 30 days (volatile), and the key still opens it; replacing the key leaves older Time Travel copies under the old one.
- The instruction isn't checked against the insult list: only the label is public, and an answer's words are the model's, as in every chat.
- A label already sent stays in the hirers' request bytes until their memory is cleared.

## Action Items
1. [x] The build proves that NEAR AI takes the random field and the `provider_tee` signature still matches (`near-ai` › For the build). Proven 2026-11-03: NEAR AI took a top-level `nonce`, and the `provider_tee` signature matched `<model>:<sha(req)>:<sha(res)>` (one paid call on dev).
2. [ ] The user generates the key, types it as a Worker secret per env, keeps a copy outside Cloudflare (`cf-worker` › Setup). Dev, 2026-11-03: the key was generated and set on nearling-dev by script, never shown or kept (the user's choice for dev); prod's key at R1.
3. [ ] README › Known limitations names what the filter and the encryption don't do (product-lead).
