# ADR-009: The riddle of the day — what is committed, when it is revealed, and a reveal that never comes

**Status:** Accepted — the user's decision 2026-10-28, OD-370 → «Только после записи в сети» (Option A); the defaults below accepted by the user 2026-10-28 («Принимаю все»); critic MAJOR 4 → «Платит аккаунт сервера» (2026-10-28): the commit storage comes from the server account, not the pool.
**Date:** 2026-10-28
**Deciders:** the user (OD-370, defaults); tech-architect (proposal)

## Context
One riddle a UTC day for every player (§4 › Ежедневный ритуал); its answer is sealed on chain before the first attempt and revealed the next day; the owner learns whether they were right tomorrow, together with the revealed answer (the user's decision 2026-10-28, OD-362). The riddle list with its accepted answers is a server secret, not in the public repo. Players' answers stay in D1 and never go on chain. The commit exists so that the server cannot change the answer after seeing how players answered (`near-contract` › Commit-reveal: "Bind the commitment to the account and round, set deadlines for both phases, and define what happens when a user does not reveal" — [frontrunning](https://docs.near.org/smart-contracts/security/frontrunning)). The server's key is a function-call key without allowance (ADR-002): the contract checks the caller.

## Decision
The verdict and the answer are shown only once the reveal is written on chain (Option A, OD-370). Until then Diary screen shows «Yesterday's answer is on its way.»; when the next UTC day begins, that riddle leaves the screen without a verdict, and the owner's answer is erased from D1 with it (`Ritual data`). The reveal itself still goes out whenever it can — it has no deadline. On the gas pause of the server account the commit and the reveal wait for it to lift; the NEAR AI pause does not stop them.

## Accepted defaults
- **What is committed:** sha256 of (UTC day, riddle text, every accepted answer, a random salt). The day binds the commit to its round; the salt stops anyone from hashing guesses against a short answer; the accepted answers are all there, so the verdict «case-insensitive, any accepted answer» can be checked by anyone after the reveal.
- **The round is the contract's clock:** `riddle_commit(hash)` takes no day argument — the contract files it under the UTC day of `block_timestamp` and accepts one commit a day. The server opens the riddle to players only once the commit is written.
- **Reveal window:** opens at 00:00 UTC after the riddle's day — never during it, so the answer is not published while the riddle is open — and never closes: a late reveal still proves the answer, and nothing on chain depends on it.
- **Storage:** the commit is a state record (≈ 0.0011 NEAR [estimate: near-contract › What it costs]); both phases also emit NEP-297 events (`riddle_commit`, `riddle_reveal`), so the explorer keeps the whole history after the record is deleted.
- **Who pays the commit's storage (critic MAJOR 4, the user's decision):** the server account, never the pool or the pets' food — births, including sybil births, empty the pool, and the riddle must not stop with it. The server's key is a function-call key, and a function-call key cannot attach NEAR (`near-contract` › Who may call `debit`, [access keys](https://docs.near.org/protocol/accounts-contracts/access-keys)), so `riddle_commit` cannot carry a deposit. Instead the contract keeps a separate commit-storage reserve, credited by `riddle_storage_fund` (a deposit; the user sends it from the server account with that account's full key) and returned to on reveal; no method withdraws it. `riddle_commit` fails when the reserve is below the commit's storage — that day's riddle does not open (`Riddle commit contract` › «запас хранилища пуст»). ~0.01 NEAR covers ~9 unrevealed commits [estimate: arithmetic].
- **What becomes public, for good:** each day's hash and commit time; after the day, the riddle text, its accepted answers and the salt. Nothing about any player.

## Options Considered (OD-370 — the reveal never comes)
A reveal can be missing because of the gas pause of the server account, the network, or a lost salt. The commit then stays unrevealed on chain for good — a public mark against the project.

### Option A: the verdict only after the reveal (chosen)
Until the reveal is written, Diary screen shows «Yesterday's answer is on its way.»; when the next day begins, that riddle leaves the screen without a verdict. +~0 Scenarios. The verdict the player sees is always backed by the chain.

### Option B: the server's own verdict after a deadline
At e.g. 12:00 UTC the server shows the answer and the verdict from its D1 copy, marked as not yet on chain. +~1 Scenario. The player always gets a verdict, but exactly in the case where the proof is missing the verdict is unproven — the case the commit exists for.

## Consequences
- A stolen server key can write a foreign hash first on a given day: that day's riddle cannot be sealed, so it never opens (`Riddle rule` › «загадка ещё не запечатана»), until the user revokes the key (ADR-002). It cannot reveal early, and future answers are not in the key. It cannot withdraw the commit-storage reserve; by never revealing its own commits it locks ≤ one commit's storage a day.
- On the gas pause the server sends neither commits nor reveals; they go out once it lifts.
- Cut order (§3 › Сумма): if «коммит загадки в сети» is cut, `Riddle commit contract` and `Riddle reveal contract` go and the server reveals the answer itself.
- Gas: two transactions a day for the whole game, ≈ 28 for the playtest — inside the accuracy of §4.
