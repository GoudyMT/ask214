# On-Device Ask: Engineering Decisions

## Overview

Ask can answer entirely on the user's device. A small model in a Web Worker turns the question into a vector,
and the app searches the corpus index stored in the browser, so the question never leaves the device and the
answer works offline. It is opt-in: about 55 MB, downloaded once. Each decision's full reasoning is kept in
private working notes.

## Stack at a Glance

| Layer   | Tool                              | Version  | Purpose                                    |
| ------- | --------------------------------- | -------- | ------------------------------------------ |
| Library | Transformers.js                   | 4.2      | Runs the model in the browser              |
| Model   | all-MiniLM-L6-v2, quantized (q8)  | n/a      | 384-number question vectors; 23 MB         |
| Engine  | ONNX Runtime Web, WebAssembly     | 1.26 dev | Runs the model; 23.6 MB, served by the app |
| Thread  | Web Worker                        | spec     | Keeps inference off the page's main thread |
| Index   | `corpus-v1.0.2` passages, vectors | 1.0.2    | 1,992 passages; 7.3 MB                     |
| Storage | Cache API, `ask-assets-v1`        | spec     | Keeps all of it across releases            |

## Decisions and Reasoning

### Opt-in setup

**What it is.** Nothing downloads on its own. The first on-device question on a device that is not set up
asks first, and the setup downloads the model, its tokenizer, the runtime and the answer library, about 55 MB.
Setup first waits, up to a time limit, for the service worker to take charge of the page, so the files go into
its cache. Whether a device is set up is read from the cache itself, never from a remembered flag, because a
flag drifted from the cache whenever the browser deleted files or a write failed on a full disk. After two
online questions the app suggests the setup until dismissed, and the user can make on-device the default in
Settings.

**Why this project uses it.** 55 MB is a lot on a phone plan; the user decides when to spend it.

**Tradeoffs accepted.** The first on-device answer waits for the download, and on a first visit the setup waits
a few seconds for the service worker.

---

### A self-hosted model and runtime

**What it is.** The model files and the ONNX Runtime WebAssembly are served from ask214.com (`static/models/`,
`static/wasm/`). The worker turns off remote models and points the runtime at `/wasm/` before anything loads,
so Transformers.js never reaches the Hugging Face CDN or jsDelivr. A worker does not inherit the page's Content
Security Policy, so these settings, and a test that holds them, are the guard. A SHA-256 manifest pins the four
model files, a test requires the vendored runtime to match the installed `onnxruntime-web` byte for byte, and
the page's policy allows `'wasm-unsafe-eval'` so the WebAssembly can compile. The runtime is single-threaded,
so no cross-origin isolation headers are needed.

**Why this project uses it.** A question embedded on the device never leaves it, and a CDN request would tell a
third party the app is in use.

**Considered alternatives.** The library's default, loading the model and runtime from public CDNs.

**Tradeoffs accepted.** We host 47.3 MB of model and runtime, and a library update means vendoring the runtime
again. The runtime is the development build that Transformers.js 4.2 pins.

---

### The worker

**What it is.** Inference runs in a Web Worker, and the page matches replies to requests by id. The first
embedding, which may include loading the model, is not timed; after that, a reply that takes longer than 15
seconds is an error, and a crashed worker fails every request at once, so the screen is never left waiting. A
failed model load is not kept, so a download dropped part-way can be retried. The worker's scripts are held to a
budget of 147,200 bytes gzipped.

**Why this project uses it.** A model running on the main thread would freeze the page while it thinks.

**Tradeoffs accepted.** One more script to keep for offline use; the service worker stores it at install on a
set-up device.

---

### Search and the result cards

**What it is.** The question vector is compared with all 1,992 passage vectors by cosine similarity, using the
same code as the server. The top 5 are kept, and any scoring below 0.4 are dropped; the cutoff is set by the
corpus quality gate. Each card shows its passage and opens the official document at the cited place. The index
loads with the first on-device question, not with the page. When nothing clears the cutoff, the app says it
found no close match and suggests rephrasing or va.gov; it does not claim the documents lack the answer, since
other wording often finds it.

**Tradeoffs accepted.** Every question scans every passage. That is fast at this size and would need an index
structure at a much larger one.

---

### The answer block

**What it is.** Above the cards, the answer block shows the opening sentences of the lead passage, whole, up to
120 words, with its citation. It is extracted, never generated. A question about the user's own eligibility
gets the impersonal treatment on every path, this one included, and a message that reads as a crisis goes
straight to crisis line help before any search runs.

**How it is measured.** `pnpm answer-gate` runs in CI over a 135-question benchmark, comparing the block with
the lead card it replaced and holding absolute regression floors.

**Why this project uses it.** A shorter excerpt, chosen by matching words, began partway into a passage and
often dropped the condition, deadline or negation that governed it; whole opening sentences keep them.

**Tradeoffs accepted.** The block is only as good as the top passage: when the answer sits in a lower card, the
block misses it. The floors guard against regression and sit below the product's target, which the block does
not yet meet.

---

### Offline across updates

**What it is.** Everything above lives in `ask-assets-v1`, the cache whose name does not change between
releases. When a new release installs on a set-up device, it fetches the new answer library and the worker's
script while still online, so on-device answers keep working after an update with no connection, and
activation prunes the old versions. The app itself opens offline from the first visit. An end-to-end test
answers a question with the network off; it is too heavy for CI and runs in the local gate before every pull
request.

**Tradeoffs accepted.** A set-up device downloads each new answer library at install, before anyone asks a
question.

## How These Pieces Fit Together

The setup puts a pinned model and runtime, served by the app, into a cache that outlives releases. The worker
runs the model off the main thread, the search ranks every passage against the question, and the answer block
quotes the best one whole. Updates refresh what changed while the device is online, so the next question works
with no connection at all.

## Standards Adopted in This Section

- **Nothing downloads without asking.**
- **No third-party request at runtime**; the model and runtime are pinned and served by the app.
- **The cache is the record** of what a device holds.
- **Answers are extracted, never generated**, on this path.
- **An empty search is hedged**, never presented as proof the documents lack the answer.

## Further Reading

- Transformers.js: https://huggingface.co/docs/transformers.js
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/
- all-MiniLM-L6-v2: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- Web Workers: https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API
- Cache API: https://developer.mozilla.org/en-US/docs/Web/API/Cache
- CSP and WebAssembly: https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src

## Revision Notes

- 2026-10-02: First draft.
