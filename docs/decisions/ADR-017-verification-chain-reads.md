# ADR-017: Where the verification page reads the chain

**Status:** Accepted (OD-1080 → Option A, the user, 2026-10-28)
**Date:** 2026-10-28
**Deciders:** the user

## Context
The verification page (`add-verification`) shows a pet's on-chain record and the receipt of each thought, and lets the owner check the request and response bytes against the receipt (§3 › Отличие, critic MAJOR 9). If the hashes, the signature and the record all come from our own server, the check compares our server with itself and proves nothing about the chain.

Three facts shape the options:
- A receipt is a NEP-297 event inside a `debit_session` transaction (ADR-004). Events are not contract state: a view method cannot list them. Listing "the last 20 receipts of token_id N" — including a worker's answers recorded in the hirer's batch — needs an index: ours or a third party's (`near-contract` › State vs events).
- An accepted add-pet default (2026-10-27): the browser reads pet state only via the server; §8 says the browser talks only to the server and the login provider.
- Public `rpc.*.near.org` is deprecated and rate-limited; production uses a provider such as FastNEAR (`near-contract` › Pitfalls). How long a non-archival RPC node returns an old transaction, CORS and rate limits for browser calls, and NearBlocks API prices and terms are not in our knowledge skills: research gaps.

## Options Considered

### Option A: Our index for pointers, the browser reads the chain itself
| Dimension | Assessment |
| --- | --- |
| Complexity | Medium: the server keeps the index (`Receipt index data`), the browser reads transactions and views over RPC and checks hashes and the ECDSA signature |
| Cost | ? [gap: RPC provider for browser reads — free tier limits, archival access for older transactions] |
| Trust | The server can omit a receipt from the list, never swap one after it's recorded: every shown item is read from the chain by the browser. What goes into a receipt — hashes, signature, signer address — is the server key's word: the contract doesn't check the signature |
| Privacy | New recipient: the RPC provider sees the viewer's IP, the token_id and the transaction hashes; retention unknown |

**Pros:** the check is independent of our server; no new company beyond the RPC provider the stack already uses.
**Cons:** reverses, for this page only, the accepted default "the browser reads pet state only via the server"; depends on RPC limits from the browser.

### Option B: The browser reads list and transactions from the NearBlocks API
| Dimension | Assessment |
| --- | --- |
| Complexity | Low on our side for public data; the server still answers the thought's state (in session, paid by the project) and the owner's bytes |
| Cost | ? [gap: NearBlocks API price, rate limits, CORS] |
| Trust | Independent of our server, dependent on NearBlocks' index |
| Privacy | New third party: NearBlocks sees the viewer's IP and the token_id; terms and retention unknown [gap] |

**Pros:** no index of our own for the list; an explorer the judges already know.
**Cons:** a new third party with unknown terms; its index can lag or change.

### Option C: Only our server
| Dimension | Assessment |
| --- | --- |
| Complexity | Low |
| Cost | $0 beyond today's stack |
| Trust | The page shows what our server says; independence only through the "See on the explorer" link, compared by eye |
| Privacy | Nothing new leaves the browser; §8 unchanged |

**Pros:** simplest; keeps the accepted default.
**Cons:** «Request and reply match the receipt on NEAR» would be proven against our server, not the chain — the page could not honestly say so.

## Trade-off Analysis
A and B buy independence from our server at the price of a new recipient of the viewer's IP; A keeps that recipient to the RPC provider already in the stack, B adds a company whose terms we don't have. C costs nothing and keeps §8 as is, but weakens the one claim the page exists for.

## Recommendation
Option A — the page's point is that the check does not trust us (§3 › Отличие); the RPC provider is already part of the stack. Volatile: RPC providers' free limits and archival access (research gap).

## Decision
Option A (the user, 2026-10-28: «Сам из сети через RPC»). Our server gives the receipt list (`Receipt index data`); the viewer's browser reads every transaction and view itself from FastNEAR's public RPC without a key — the regular endpoint for fresh transactions, `archival-rpc.mainnet.fastnear.com` for older ones. The accepted add-pet default «the browser reads pet state only via the server» is lifted for the verification page only.

Facts it rests on (`research/gap-public-rpc-browser-verification.md`, own tests 2026-10-28, one IP, one afternoon):
- CORS: FastNEAR regular, free and archival endpoints answer a browser origin with `Access-Control-Allow-Origin: *`; `tx` returns receipt logs with `EVENT_JSON:`; `query call_function` works from a browser origin.
- History: regular nodes found transactions ~16 h old and not 2.6 d old (earliest block ~16–30 h back); older receipts need the archive.
- Archive without a key answered every test request, while the NEAR docs table lists FastNEAR archival as "Paid only" — **volatile**. Fallback: FastNEAR Dev, $69/month, 10M requests, one API key restricted to our domain (fastnear.com pricing, docs.fastnear.com/auth).
- FastNEAR's free limit is not published — **volatile**. Its privacy policy names IP addresses in usage data, doesn't describe RPC logging separately, and states no retention period — retention «unknown».
- Per the user (2026-10-28), the unreached items (NearBlocks/Pikespeak, dRPC terms, FastNEAR IP logging, free limit, keyless archive) stay volatile and are re-checked before the build.

If keyless archive access ends, we don't pay (OD-1120 → «Too old to check here» + explorer, the user, 2026-10-28): the browser never calls a paid archive, a keyed endpoint or another archival provider; a receipt or record item older than the regular node's history gets no mark and an explorer link (`Verification reads data` › «архив закрыт», `Verification screen` › «чек слишком старый»). How a closed keyless archive answers (an auth error vs a rate limit) is not known — volatile, re-checked before the build, since the page must tell it from «сеть не отвечает».

## Consequences
- §8 › «Уходит из браузера» has the FastNEAR row; the intro sentence of §8 names the exception; «Хранение» names FastNEAR with retention unknown.
- A broken pointer from our server shows as `Verification flow` › «не сошлось», not as a pass (`Verification reads data` › «указатель не ведёт к чеку»).
- An unreachable or rate-limiting RPC gives no mark and no fallback to our server's word (`Verification reads data` › «сеть не отвечает»); the viewer sees `Verification screen` › «сеть не читается».
- Cost $0, also if keyless archive access ends (OD-1120): then older items are checked only on the explorer, outside the page; FastNEAR Dev ($69/month) is not bought.
- The character seal of a pet hatched more than ~a day ago reads its birth event from the archive: with the archive closed it falls under «архив закрыт» too.
- Reading a receipt from the chain proves it wasn't swapped after it was recorded, not that its signer is NEAR AI's hardware: the server's key (or a thief's) can record its own hashes signed by its own key. The page's mark says only «Signed by key {signer}»; whose key it is shows only NEAR AI's page (ADR-018; critic BLOCKER 1 → «Честная отметка», the user, 2026-10-28).
