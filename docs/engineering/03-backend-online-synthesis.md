# Backend + Online Synthesis - Engineering Decisions

## Overview

The app answers questions two ways: fully offline on the user's own device, or online through a small server that runs the same search over the same public government documents. This section documents the online path - a stateless, secret-free retrieval service built entirely on a cloud free tier and designed so it can never generate a bill. The service turns a question into a vector, searches a pre-computed index of public documents, and returns the matching passages with their sources. An optional AI-written summary is a later phase, kept on the user's own device and key, so no key or question reaches our servers.

The retrieval service is in active development. The architecture below is locked, and each load-bearing assumption was validated by a pre-build spike before any code depended on it - the model's quality on live serving, the free-tier limits, and the browser reachability of the summarization path.

## Stack at a Glance

| Layer              | Tool                             | Tier | Purpose                                               |
| ------------------ | -------------------------------- | ---- | ----------------------------------------------------- |
| Compute            | Cloudflare Workers               | free | Stateless request handler at the edge                 |
| Server inference   | Workers AI (`bge-small-en-v1.5`) | free | Embed the question into a 384-dimension vector        |
| Shared counter     | Durable Objects (SQLite-backed)  | free | Global daily-usage circuit-breaker                    |
| Index storage      | Workers KV                       | free | Hold the ~2.9 MB vector index; read once per instance |
| Repeat-query cache | Workers Cache API                | n/a  | Skip re-embedding identical questions                 |
| Vector search      | Hand-rolled cosine top-k (TS)    | n/a  | Rank passages; shared with the offline path           |
| Burst control      | WAF rate-limiting rule           | free | Per-IP request limit                                  |
| Edge config        | `wrangler.jsonc`                 | n/a  | Logging off, no secrets, no gateway                   |

## Decisions and Reasoning

### Zero operating cost as an architectural constraint

**What it is.** The service is designed to run at $0 as usage grows - not merely "cheap."

**Why this project uses it.** The app has no revenue and carries no ads; a bill that scales with users would be an existential risk.

**How it is guaranteed.** Every free limit on the platform (compute requests, database writes, the model's daily budget) stops with an error rather than charging, and the account carries no payment method and is never on a paid plan - so there is structurally nothing to bill.

**Tradeoffs accepted.** Under heavy load or a determined attack, the online path can degrade to "high demand - use offline mode" for the rest of the day. It degrades; it never bills. For a free public service, that is the right trade. -> [ADR-005](../decisions/005-hybrid-retrieval-synthesis.md), [ADR-025](../decisions/025-stateless-backend-security-model.md).

---

### Server-side embeddings on the edge

**What it is.** The server converts a question into a 384-number vector using a compact open embedding model run on the provider's edge inference.

**Why this project uses it.** The online path exists for users who cannot or do not want to download the ~50 MB on-device model. Embedding at the edge gives them an instant, zero-download answer with the same search-and-cite behavior.

**Considered alternatives.** A managed vector database - rejected as unnecessary cost and an added data-custody question for a small, static index. A larger embedding model - rejected because a pre-build spike showed the compact model clears our quality floor on real serving.

**Tradeoffs accepted.** Two embedding models now exist (device and server); they must be evaluated and versioned together so both meet the same bar. -> [ADR-025](../decisions/025-stateless-backend-security-model.md).

---

### A Durable Object for the usage circuit-breaker (the choice we changed)

**What it is.** A single, always-consistent object holds today's running usage total. As usage nears the free ceiling, the service pre-emptively returns "high demand" for everyone until the daily reset - an abrupt cutoff becomes a predictable, graceful degrade.

**Considered alternatives.** A key-value store (KV) is the obvious first reach, but its free tier allows only ~1,000 writes/day and can read a just-written value back stale - a per-request counter would exhaust that budget and miscount. Durable Objects, historically a paid feature, now offer a free SQLite-backed tier suited exactly to this one-shared-counter job.

**Why the change.** The design first noted "KV or a Durable Object." Researching the free-tier limits settled it decisively: the Durable Object is both the correct tool (accurate, shared, instant) and now free, where KV is neither accurate enough nor within budget for a per-request counter.

**Tradeoffs accepted.** One more moving part than a single KV key - but KV cannot do this job within the free tier, so the "simpler" option was a false economy. -> [ADR-025](../decisions/025-stateless-backend-security-model.md).

---

### KV for the index, read once and held in memory

**What it is.** The ~2.9 MB search index (public documents pre-computed into vectors) lives in KV, is read once when a server instance warms up, and is then kept in memory for every later request.

**Considered alternatives.** Bundling the index into the Worker's code risks the free code-size limit.

**Tradeoffs accepted.** The first request to a cold instance pays a one-time read; every warm request is instant. Reads are the cheap, plentiful free operation, so this fits comfortably.

---

### The Workers Cache API for repeated questions

**What it is.** Identical questions reuse a cached vector instead of paying to compute it twice.

**Why the Cache API and not KV.** The cache is written on a miss; KV's ~1,000-writes-per-day cap would choke, while the Cache API is free with unlimited writes.

**Tradeoffs accepted.** The cache is best-effort - an evicted entry simply recomputes. No correctness risk.

---

### An isolated, secret-free Worker

**What it is.** The retrieval service is its own single-purpose Worker with logging disabled and no secrets, rather than a route inside the main application.

**Why this project uses it.** "No secrets, no logging, no data retention" becomes a property of one small config file a reviewer can read in full, instead of a promise spread across a larger app with other concerns. The service holds no keys at all - the optional AI-summary feature uses the user's own key, called directly from their browser, so no key ever reaches our servers.

**Tradeoffs accepted.** A second deploy target and a routing rule - worth it for a guarantee you can verify by reading one file. -> [ADR-025](../decisions/025-stateless-backend-security-model.md).

---

### Two independent indexes, one build

**What it is.** A single content build emits two search indexes from the same public documents - one for the on-device model, one for the server model - carrying the same version.

**Why this project uses it.** The offline and online paths must return comparable results and cite the same sources. Building both from one pipeline keeps them honest, and a version handshake lets the client detect and refuse a mismatched server.

**Tradeoffs accepted.** The build does twice the embedding work and ships a second index; the payoff is that offline and online are the same product, not two that drift apart.

## How These Pieces Fit Together

A question arriving online is checked cheaply first - from our own site? short enough? budget intact? - before any metered work happens. Only then is it embedded on the edge, searched against the in-memory index, and returned as cited passages or an honest "no official source covers that." A per-IP rate limit blunts bursts; the shared circuit-breaker caps the day; every failure path degrades to the offline experience rather than to a blank screen or a bill. Because the decision rules live in ordinary unit-tested functions and only a thin layer touches the platform, most of the service is testable on a laptop, and the risky parts were de-risked by spikes first.

## Standards Adopted in This Section

- **$0 or it does not ship.** No design may introduce a cost that scales with usage; the no-payment-method account is the hard guarantee.
- **Empirical build-gates.** Load-bearing platform assumptions (model quality on real serving, free-tier limits, browser reachability) must pass a real spike before code depends on them.
- **Zero secrets server-side.** The retrieval Worker holds no keys; any provider call uses the user's own key, browser-direct.
- **Degrade, never bill; degrade, never lie.** Only a genuine empty result shows the "no source" message; every failure degrades to another path.
- **Pure logic out of the runtime.** Decision rules are unit-tested functions; the platform layer is thin glue.

## Further Reading

- Cloudflare Workers: https://developers.cloudflare.com/workers/
- Workers AI: https://developers.cloudflare.com/workers-ai/
- Durable Objects: https://developers.cloudflare.com/durable-objects/
- Workers KV: https://developers.cloudflare.com/kv/
- Cache API: https://developers.cloudflare.com/workers/runtime-apis/cache/
- WAF rate limiting: https://developers.cloudflare.com/waf/rate-limiting-rules/

## Revision Notes

- 2026-07-29 (initial draft): Backend retrieval architecture + the $0 model captured at Phase-2 task-detailing. The usage circuit-breaker was resolved to a SQLite-backed Durable Object over KV after free-tier research. The on-device/server duality and the isolated secret-free Worker are locked; the optional bring-your-own-key summary path is documented when built.
