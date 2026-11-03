# ADR-024: How a skill's data source is described and called

**Status:** Accepted (OD-1820 → «MCP-сервер», option A, the user, 2026-11-03)
**Date:** 2026-11-03
**Deciders:** the user

## Context
An owner connects up to 3 data sources to a pet's skill (OD-1791): keyless access to any outside data (OD-1793; the user, 2026-11-03: «Это просто… доступ к внешним данным»), their own or from a free public catalog (OD-1792). The user called them «кастомный MCP» and «как плагины», and asked for «нормальное решение» rather than his rough words. The accepted defaults (2026-11-03) bind any design:
- a test call at «Check address» and at save; the address never reaches the browser after save or the model;
- the owner ticks which tools the pet may call; only parameters that are names, numbers, addresses or picks from a list; the asker's text never goes there;
- the output is hostile data, ≈ 4,000 tokens into the request [hypothesis], cached ≤ 60 s; busy, slow or down → an honest line, no fee;
- the game builds no source adapters of its own (Out of v1).

Facts: research/gap-skill-code-sandbox.md › 3 (MCP spec 2025-11-25, OpenAPI converters, Code Mode, registries) and › 4 (raw open-API answers often exceed ≈ 4,000 tokens: Hyperliquid `allMids` ≈ 6,400, `metaAndAssetCtxs` ≈ 18,000, 30 daily candles ≈ 1,100).

## Decision (OD-1820, the user, 2026-11-03)
**A. A data source is a remote MCP server over Streamable HTTP, keyless.**
- The Worker is the MCP client: `initialize`, `tools/list` at the test call, `tools/call` on a job. One JSON-RPC message per HTTPS POST, the answer one JSON object or an SSE stream (research › 3.1).
- Tools carry their own name, description and JSON Schema input: the sheet shows them, the type rule ticks them, nothing is converted.
- Keyless: a server that answers 401 or asks for OAuth is not saved. The address is `https://host/path`, no userinfo, query or fragment.
- The type rule: a tool is tickable when every parameter is a number, an integer, a boolean, a string with an `enum`, or a string; objects, arrays and strings whose schema allows more than 64 characters are «free text». On every call each string value must be 1–64 characters of letters, digits and `. _ - :` (a symbol, a NEAR account, a 0x address, a hash); otherwise the call doesn't go. So a sentence of the asker's never leaves.
- Narrowing: MCP tools take parameters, so a source can return one symbol instead of 1,423; whatever still runs over is cut at 16,000 characters (≈ 4,000 tokens) before the model, marked as cut. Skill code (ADR-025) narrows further.
- Skill code has no network of its own: it calls its skill's ticked tools through one door the Worker gives it, under the same type rule and cache.
- The model sees the tools' names, descriptions and parameter types (the tool list is hostile text too: a description can't hire, write memory or move food, `Errand content rule`), never the address.

## Options Considered

### Option A: remote MCP server (Streamable HTTP) only
| Dimension | Assessment |
|---|---|
| Complexity | Low–Med: a small JSON-RPC client in the Worker; SSE parsing |
| Cost | $0 per call to the game (OD-9: nobody reimburses the source's host) |
| Coverage | any public MCP server (registries list thousands, research › 3.4); a plain REST API needs someone to host a small MCP server once, and a catalog entry then serves every pet |
| Scenarios | +0 (Adapter connect flow is already MCP-shaped) |

**Pros:** the user's own word and the standard agent tool format; descriptions and typed parameters come from the source; one protocol for test, ticks and calls; the catalog entry is just an address and its tool list.
**Cons:** Polymarket or Hyperliquid can't be pointed at directly; the user's example pets need a small MCP server each (or one from a registry).

### Option B: MCP server or an OpenAPI 3 document
| Dimension | Assessment |
|---|---|
| Complexity | Med–High: a converter (one tool per path and method, flattened parameters, `nullable` fixes, lossy bodies), research › 3.2 |
| Coverage | adds REST APIs that publish an OpenAPI document; many don't |
| Scenarios | +~2 (document invalid; too many operations, the owner picks) |

**Pros:** a public API with a document needs no server in between.
**Cons:** the game writes and maintains a converter; nested POST bodies (Hyperliquid's `{"type":…,"req":{…}}`) fail the type rule; raw answers are large, so most need code anyway.

### Option C: MCP server, or a plain https API host only skill code may call
| Dimension | Assessment |
|---|---|
| Complexity | Med: the code's door also forwards plain `fetch` to its declared hosts |
| Coverage | any REST API, through owner code |
| Scenarios | +~3 (a host without code can't be saved; the host's own test; the catalog entry of a host has no tools) |

**Pros:** owner code reads any keyless API directly and narrows it, like an agent skill.
**Cons:** two kinds of source on one sheet; a host source is useless without code; a catalog entry of a host shows no tools, so a connecting owner sees less of what they connect.

## Trade-off Analysis
A covers the user's «кастомный MCP» exactly and keeps every accepted default enforceable in one place (the Worker's client): ticks, the type rule, the cut, the cache, the honest failure. B and C widen what an owner can point at, at the price of a converter (B) or a second kind of source (C). Because the user will hand-make a couple of example pets, one small hosted MCP server per example costs less than either. C is the step to take if owners ask for raw APIs: it changes the sheet, not the data model.

## Consequences
- Easier: the catalog is a list of MCP addresses; any MCP-aware tool can test a source the same way.
- Harder: an owner without an MCP server can't connect a plain API (A).
- The source's host sees each call's tool, its typed values, the time and Cloudflare's address, never the player, the question or the answer.
- MCP servers MUST check `Origin` (spec); the Worker sends none, server to server. Session ids are kept only for one job.
- Whether the official `@modelcontextprotocol/sdk` client runs in a plain Hono Worker is unchecked (research › Couldn't reach); the build either proves it or writes the few JSON-RPC calls by hand — no Agents SDK, no Durable Object.

## Action Items
1. [x] The user answered OD-1820 with A (2026-11-03).
2. [ ] The build proves one keyless public MCP server end to end on `dev`: test call, ticks, a job call, the cut, the cache.
3. [x] The build proves whether NEAR AI takes client `tools` and returns `tool_calls` with a `provider_tee` signature on `Qwen/Qwen3.8-27B`; if not, the model names the tool and values as JSON in its reply and the server parses it (no Scenario changes). Proved 2026-11-03 on `dev` (the user's yes, one paid call): non-streamed, one function, `finish_reason: "tool_calls"`, JSON `arguments`, signature `provider_tee` over `<model>:<sha256(req)>:<sha256(res)>` (REVIEW_LOG.md, 2026-11-03 · paid recordings on dev). The JSON fallback is not needed.
