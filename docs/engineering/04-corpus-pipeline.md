# Corpus Pipeline: Engineering Decisions

## Overview

The corpus is the set of public U.S. Government documents Ask searches and the reader shows: 46 sources, 25 web
pages and 21 Transition Assistance Program guides in PDF, cut into 1,992 passages. A build-time pipeline in
`content-ops/` turns them into the search indexes and the served PDFs; none of it runs on a user's device or a
live server. Each decision's full reasoning is kept in private working notes.

## Stack at a Glance

| Stage          | Tool                         | Version         | Purpose                                 |
| -------------- | ---------------------------- | --------------- | --------------------------------------- |
| Registry       | `content/sources.yaml`, yaml | 2.x             | The legal record of every source        |
| Web capture    | fetch, Playwright, linkedom  | 1.61.x, 0.18.x  | Page text, captured politely            |
| PDF text       | PDF.js, pdftotext            | 6.3.289, n/a    | Text, cross-checked by two tools        |
| Passages       | Transformers.js tokenizer    | 4.x             | Passage size in the model's own tokens  |
| Device vectors | all-MiniLM-L6-v2, quantized  | n/a             | The on-device index                     |
| Served PDFs    | Python, pypdf, Pillow        | 3.12, 6.6, 11.2 | Copies with uncleared pictures removed  |
| Scripts        | Node `.mjs` through tsx      | 4.x             | Glue; the logic is in tested TypeScript |

## Decisions and Reasoning

### The sources registry

**What it is.** `content/sources.yaml` records each source's address, agency and copyright status (U.S.
Government work under 17 USC 105), a terms-of-use review with its date and notes, who reviewed it and when, an
update cadence (monthly for all 46), and the captured content's SHA-256 hash, path and robots.txt result.
`pnpm validate:sources` checks the schema on every commit and in CI. `pnpm build:sources-index` projects the
registry into committed TypeScript data the app reads (the About page index, citation links, the served
documents and their sizes), so the YAML parser never ships to the browser.

**Why this project uses it.** Only public U.S. Government work may enter. A source that fails that test, such
as a nonprofit's copyrighted guide, stays out.

**Tradeoffs accepted.** A person reviews every source at first inclusion and on every change.

---

### Capture and extraction

**What it is.** `pnpm ingest` (`content-ops/capture-extract.mjs`). Web pages are fetched with the pipeline's own
user agent, honouring robots.txt, at most one request a second, and their text extracted with linkedom. One
site that refuses plain requests is rendered in headless Chromium through Playwright; one behind bot protection
is ingested from a page a person saved by hand, because the pipeline never defeats bot protection. The PDF
guides are downloaded by a person and staged. Their text comes from PDF.js, the reader's own library, and is
cross-checked against pdftotext; when the two agree below 0.8 trigram similarity, the source is flagged for a
person to read.

**Why this project uses it.** Two independent extractors catch a garbled text layer that one would pass.

**Tradeoffs accepted.** The PDFs and the hand-saved page need a person at every refresh.

---

### Cleaning and review

**What it is.** `pnpm clean` drops whole-block boilerplate (tables of contents, the standard disclaimer, cover
pages) and strips running headers and footers fused into the text. A source that cleaning changed waits for a
person to approve it in a generated review page, and the approval is tied to the hash of the cleaned output, so
a change to the rules reopens it.

**Why this project uses it.** Boilerplate crowds real passages out of search, but removing text is the riskiest
step, so a person sees every edit.

**Tradeoffs accepted.** A human gate on every change to the cleaning rules.

---

### Passages and citation anchors

**What it is.** `pnpm chunk` cuts each cleaned source into verbatim passages of at most 254 tokens (MiniLM's
256-token window less its two special tokens), counted with the model's own tokenizer. Each passage records its
page in a PDF and a W3C text-quote anchor (the exact text plus a little context on each side), which the reader
uses to find and mark it. The build fails unless the passages cover every non-space character exactly once,
every anchor resolves to one place, and every passage names a known source.

**Why this project uses it.** Verbatim passages are what make a citation checkable against the official
document.

**Tradeoffs accepted.** Fixed-size passages can split a list or a table across two.

---

### Embedding and the device index

**What it is.** `pnpm embed` embeds every passage with quantized all-MiniLM-L6-v2, mean-pooled and normalised,
the same model and settings the browser uses for questions. It writes `static/corpus/corpus-v1.0.2.json`, the
passages (4.3 MB), and `corpus-v1.0.2.embeddings.bin`, 1,992 vectors of 384 numbers (3.1 MB). Passages are
sorted so the output is reproducible, a separate check confirms that embedding twice gives identical bytes, and
the step is skipped when no passage changed. The server's index is built from the same passages (see the
backend document).

**Tradeoffs accepted.** The version is in the file name, so a content change is a new 7.3 MB download for every
device that keeps the index.

---

### The quality gate

**What it is.** `pnpm eval` embeds a benchmark of questions and scores search at the source level: whether the
right document is in the top 5 (hit rate) and how high (mean reciprocal rank). It gates on a frozen held-out
30% of the questions, at a hit rate of at least 0.83 and a reciprocal rank of at least 0.6, and a failing run
stops the build. The same run tests the floor again at the device's display cutoff of 0.4.

**Why this project uses it.** Gating on the questions used for tuning would overstate quality.

**Tradeoffs accepted.** The benchmark is small, so one question moves the score by a few points. A floor is
raised when search improves and never lowered to pass.

---

### Refresh

**What it is.** `pnpm refresh` re-captures every source that can be fetched automatically into a staging area,
compares each hash with the shipped one, and writes a report for legal and quality review; the others get a
manual checklist. Only approved sources are applied: promoted, re-chunked, re-embedded, gated and stamped in the
registry.

**Tradeoffs accepted.** Detecting a change is automatic; shipping one is not.

---

### Served PDFs

**What it is.** The reader opens the official PDFs from ask214.com: 21 files, 36.5 MB. Many pictures inside them
carry no rights statement, and some name a commercial stock licensor. So `content-ops/derive_served_pdfs.py`
keeps the text layer byte-identical and keeps a picture only when its own metadata says Public Domain; every
other picture becomes a single grey pixel. It also drops embedded files, actions a viewer runs by itself, media,
thumbnails and links that open a program. Kept pictures are re-encoded as JPEG (quality 70, at most 1.96
million pixels each), which also keeps two large guides under Cloudflare's 25 MiB file limit.

**Verification is in TypeScript.** `serve-pdfs.mjs` re-extracts the capture and the candidate with PDF.js and
compares them page by page before publishing. `verify-served-pdfs.mjs` checks the published bytes: expected
names, nothing extra, the size limit, the text layer and the picture counts. `check:served-history` refuses a
pull request whose commits carry a served file the final manifest does not record, since GitHub keeps every
commit. A file's name comes from its capture hash and the derivation version, so a published name never
changes its bytes.

**Why Python.** Its PDF libraries replace images in place and Node's do not. The decision stays in TypeScript,
so the Python step cannot ship anything by itself.

**Tradeoffs accepted.** Some pages lose pictures. The Python step uses two of pypdf's private modules, so its
libraries are pinned to exact versions in `content-ops/requirements.txt`, and every upgrade needs a re-check.

## How These Pieces Fit Together

The registry decides what may enter. Capture, cleaning and chunking turn each source into verbatim passages with
anchors, and a person approves every edit along the way. Embedding builds the indexes, the quality gate decides
whether they ship, and the served PDFs give each PDF citation an official page to open. Each stage is a script
over tested functions, and each gate fails closed.

## Standards Adopted in This Section

- **Public U.S. Government work only**, reviewed and recorded per source.
- **Verbatim text.** Passages are never paraphrased, so citations can be checked.
- **A person approves every edit to source text.**
- **Gates fail closed** and are never lowered to pass.
- **Pipeline code never ships to the browser**; only its outputs do.

## Further Reading

- 17 USC 105: https://www.law.cornell.edu/uscode/text/17/105
- W3C text quote selectors: https://www.w3.org/TR/annotation-model/#text-quote-selector
- Transformers.js: https://huggingface.co/docs/transformers.js
- all-MiniLM-L6-v2: https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2
- robots.txt (RFC 9309): https://www.rfc-editor.org/rfc/rfc9309
- pypdf: https://pypdf.readthedocs.io/

## Revision Notes

- 2026-10-02: First draft.
