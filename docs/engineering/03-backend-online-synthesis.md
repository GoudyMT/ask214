# Backend and Online Synthesis: Engineering Decisions

## Overview

Ask answers online through a small search server on Cloudflare that holds no secrets, keeps no logs and is built
to cost nothing. An optional written summary goes from the user's browser straight to the AI provider, with the
user's own key. The app's one other server path is the feedback form. Each decision's full reasoning is kept in
private working notes.

## Stack at a Glance

| Layer        | Tool                            | Tier       | Purpose                           |
| ------------ | ------------------------------- | ---------- | --------------------------------- |
| Compute      | Cloudflare Workers              | Free       | The search server                 |
| Embeddings   | Workers AI, `bge-small-en-v1.5` | Free       | Turns a question into 384 numbers |
| Index        | Workers KV                      | Free       | The server's search index         |
| Daily budget | Durable Object (SQLite)         | Free       | A shared daily counter            |
| Burst limit  | Workers rate-limit binding      | Free       | 20 requests a minute per address  |
| Search       | Cosine top-k in TypeScript      | n/a        | Shared with the device path       |
| Summary      | Anthropic Messages API          | User's key | Optional, browser-direct          |
| Feedback     | Resend                          | Free       | Emails a feedback message         |

## Decisions and Reasoning

### Zero operating cost

**What it is.** The online path is built to cost nothing at any level of use. Every limit it touches stops with
an error instead of charging: Workers' 100,000 requests a day, Workers AI's 10,000 neurons a day and KV's 1,000
writes a day. The account is on the free plan with no payment method, so there is nothing to bill.

**Tradeoffs accepted.** Under heavy use or an attack, online search answers "high demand" until midnight UTC and
the app offers the on-device path instead. It degrades; it never bills.

---

### An isolated search Worker

**What it is.** `workers/retrieve` is its own Worker, `ask214-retrieve`, and Cloudflare routes
`ask214.com/api/retrieve` to it. `wrangler.jsonc` turns observability off and holds no secrets; the KV
namespace id is supplied at deploy and never committed.

**How a request runs** (`src/lib/ask/online/plan-retrieve.ts`). Cheap checks first: POST only (405 otherwise),
from `https://ask214.com` only (403), and the question cut to 400 characters. Then the per-address limit,
then the daily budget, and only then the embedding. Matches scoring below 0.6 are dropped and at most 5 return,
with the index version. A genuine no-match answers `empty`; any failure answers `error`, without the question.

**Why this project uses it.** "No secrets, no logs" becomes a property of one small file a reviewer can read in
full.

**Tradeoffs accepted.** It deploys by hand with wrangler, apart from the app's automatic deploy, so a new index
version needs a manual upload and redeploy; a manual check after every merge asks the live server one question.

---

### Server embeddings

**What it is.** Workers AI runs `bge-small-en-v1.5` on the question with its search instruction prefix (the
passages were embedded without it). The vector is compared with every passage by cosine similarity, using the
same search code as the on-device path (`src/lib/corpus/search.ts`).

**Why this project uses it.** People who skip the 55 MB on-device setup still get an answer at once, with the
same citations.

**Considered alternatives.** A managed vector database (a cost, and one more place data could sit). A larger
model (the small one passes the quality floor on the live service).

**Tradeoffs accepted.** Two models, bge on the server and MiniLM on the device, must each pass their own quality
floor. CI runs the device gate; the server gate needs live Workers AI, so it runs by hand.

---

### The index in KV

**What it is.** Two KV keys hold the index: the passages with their sources (4.3 MB) and the vectors (3.1 MB).
Each Worker instance reads them once, checks they were built with the expected model, and keeps the decoded
index in memory. Concurrent first requests share one read, and a failed read is retried by the next request.

**Considered alternatives.** Bundling the index into the Worker, which risks the code-size limit.

**Tradeoffs accepted.** The first request to a fresh instance pays the read.

---

### The daily budget

**What it is.** One global, SQLite-backed Durable Object counts each question at an estimated one neuron. Once
the UTC day's count reaches 65% of the free 10,000, about 6,500 questions, it returns "high demand" to everyone
until midnight UTC. The per-address limit runs first, so a limited request spends no budget.

**Considered alternatives.** A KV counter: 1,000 writes a day is far too few for a per-request count, and KV can
read back a stale value. A Durable Object is consistent, and the SQLite kind is on the free plan.

**Tradeoffs accepted.** One more moving part, and the per-question cost is an estimate, so the 35% margin is
headroom, not a meter. Cloudflare's rate limiter is eventually consistent, so the per-address limit is
approximate.

---

### One set of passages, two indexes

**What it is.** The corpus build embeds one set of passages twice: with MiniLM for the device (`pnpm embed`)
and with bge through Workers AI for the server (`pnpm embed:bge`). Both carry version 1.0.2. The app checks the
version on every online answer and treats a server on another version as unavailable, because a different index
could cite passages the app cannot show.

**Tradeoffs accepted.** Twice the embedding work, and two artifacts to ship together.

---

### Online Ask in the app

**What it is.** Online is the default mode. Before a device's first online question, the app asks for consent
once and remembers it. The request body is exactly `{ "query": ... }`, sent without cookies and with a
15-second timeout. A message that reads as a crisis is never sent: the app shows crisis line help at once. If
online search fails, the app offers on-device search; if both fail, it points to va.gov.

**Why this project uses it.** Only the question text leaves the device, and only after the user agrees.

**Tradeoffs accepted.** One extra tap before the first online question.

---

### The written summary

**What it is.** Optional. In Settings the user enters their own Anthropic API key, stored encrypted on the
device. With the summary on, the browser sends the question and the matched passages (id and text only) straight
to the Messages API (`claude-sonnet-5`, at most 1,024 tokens, a 30-second timeout). An allowlist limits the
request to five fields, so no user or tracking field can be added. Our servers never see the key, the request or
the summary.

**Safety layers** (`src/lib/ask/synthesis/`):

- A question about the user's own eligibility never reaches the model. The app answers impersonally and points
  to an accredited VSO or va.gov (38 CFR 14.629).
- The system prompt limits the model to the given passages and impersonal answers, forbids advice, and treats
  the question as data, not instructions.
- Every citation must name a passage that was sent, and every number must appear in the cited passages;
  otherwise the summary is refused and the source cards stand alone.
- A crisis or "not covered" reply is recognised, and the app shows its own wording instead of the model's.

**Tradeoffs accepted.** The user needs a key and pays the provider for their own use. Strict checks sometimes
refuse a correct summary.

---

### Feedback

**What it is.** `/api/feedback`, in the app's own Worker, validates the message, an optional reply address, the
page it came from and a spam trap, then emails it to the developer through Resend, with the key held as a
deployment secret. It is not stored. Each address may send three a minute; if sending fails, the form offers a
direct email address.

**Tradeoffs accepted.** The message passes through a third-party mail service; the form says it is emailed and
not stored.

## How These Pieces Fit Together

A question is checked on the device for consent and crisis, and at the server for origin, rate and budget,
before any metered work runs. Every failure falls back to the device or to official links, never to a bill. The
summary runs only between the user's browser and the provider, behind checks that refuse anything the passages
do not support.

## Standards Adopted in This Section

- **No cost that scales with use.** The free plan with no payment method is the hard guarantee.
- **No secrets and no logs on the search server.**
- **Degrade, never bill; degrade, never mislead.** Only a genuine empty search says no source covers it.
- **Decision logic in tested functions**, with the platform code kept thin.

## Further Reading

- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
- Workers AI pricing: https://developers.cloudflare.com/workers-ai/platform/pricing/
- Durable Objects pricing: https://developers.cloudflare.com/durable-objects/platform/pricing/
- Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Rate limiting binding: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Anthropic Messages API: https://docs.anthropic.com/en/api/messages

## Revision Notes

- 2026-07-29: First draft, the retrieval architecture and the zero-cost model.
- 2026-10-02: Updated to the live service; the query cache, never built, removed.
