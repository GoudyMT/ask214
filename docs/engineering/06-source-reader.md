# Source Reader: Engineering Decisions

## Overview

Every answer opens the source it came from. For the 21 PDF guides, the reader shows the official document,
served from ask214.com, at the cited page with the passage marked; for the 25 web pages, it shows the text and a
link to the live page. Documents can be saved for offline reading, from the reader or all at once from the
Documents page. Each decision's full reasoning is kept in private working notes.

## Stack at a Glance

| Layer          | Tool                            | Version | Purpose                                     |
| -------------- | ------------------------------- | ------- | ------------------------------------------- |
| PDF engine     | PDF.js (`pdfjs-dist`), vendored | 6.3.289 | Draws pages and reads their text layer      |
| Reader         | Native `<dialog>`               | spec    | Focus trap, Esc and backdrop                |
| Passage finder | `highlight-match.ts`            | n/a     | Finds a stored anchor in the page text      |
| Text view      | The answer library              | 1.0.2   | Every source's text, offline                |
| Storage        | Cache API, `ask-assets-v1`      | spec    | Saved documents and the libraries they need |

## Decisions and Reasoning

### A modal reader with two views

**What it is.** The reader is a native `<dialog>` opened with `showModal()`, which brings the focus trap, Esc
and the backdrop. It has two views of one source: Page, the served PDF, and Text, the source's passages from the
answer library. A web page source has only the Text view, plus a link to the page. For a PDF guide, the link out
goes to that guide at the cited page, not to the shared directory page the registry lists for all 21. Each view
keeps its own scroll position when the user switches. On a short screen, such as a phone turned sideways, the
view switch and the Save scroll with the document while the title and the page bar stay pinned.

**Why this project uses it.** Opening a source is a content moment, so it gets a modal, like the app's other
heavy moments. The Text view works offline for every source and reads well with a screen reader.

**Tradeoffs accepted.** Two views to keep in step, each with its own place.

---

### The page view

**What it is.** PDF.js loads only when a served document opens, never with the Ask page, from
`/pdf-worker/6.3.289/`. The folder is named for the release, so a new library never meets an old cached worker,
and `check:pdf-worker` fails CI when the vendored files differ from the installed package. The document
downloads whole, never in byte ranges, because a saved copy is served whole; its size is shown with a loading
bar, and a download that stalls is stopped. Every page takes its size before any page is drawn (17 ms for the
228 pages of the largest guide), so nothing shifts as pages render. Pages are drawn as they near the view and
released when far from it, so a long guide never holds every page in memory. A page bar shows the page in view
and takes a typed page number. A note says the copy is without its pictures, or most of them. If the document
cannot load, or the device is offline and it is not saved, the reader falls back to the Text view.

**Why this project uses it.** A citation is worth most when the reader can check it in the official document.

**Tradeoffs accepted.** Viewing keeps nothing, so an unsaved document downloads again each time it is opened.
Every PDF.js upgrade means copying its files again.

---

### Finding and marking the passage

**What it is.** Each passage carries the text-quote anchor the corpus build gave it. The matcher searches the
page's text layer for it, tolerating the footer and header a page break puts in the middle, and marks it on
every page it covers; the words the answer block showed are tinted inside it. If the passage is found on a
different page from the citation, the reader lands there and names both pages; if it is found nowhere, the
reader says so instead of marking something else. In CI, `pnpm highlight-gate` runs the shipped matcher over
every anchored passage against the real documents with the same PDF.js, with floors of 99% for the right
document and page, 95% for the passage located, 88% for a mark on the cited page and 95% for the quoted words
inside the mark.

**Why this project uses it.** A citation helps only if it lands on the sentence it cites.

**Tradeoffs accepted.** A text layer that splits a sentence oddly can defeat the match. The floors allow a
small share of misses, and the reader names a miss rather than guessing.

---

### Keeping the reader's place

**What it is.** The page view records its place as the page at the top of the view and how far down that page
the top sits, as a share of the page's height. A phone turned or a scrollbar appearing changes every page's
height, and the same share of the same page is the same place, so a `ResizeObserver` puts the view back after a
resize, before the frame is painted. Page sizes and marks are stored as fractions, so the pages reflow to the
view's width. The page in view is the last one whose top has passed a line a third of the way down.

**Why this project uses it.** WebKit keeps no scroll position for content that changes size, so a phone turned
mid-document would otherwise lose the reader's place.

**Tradeoffs accepted.** Code that answers every resize. Browser tests turn a simulated phone and check the page
in view stays the same.

---

### Saving for offline

**What it is.** Viewing keeps nothing on the device: the service worker passes a viewed document through
without storing it, and only the user's Save stores one, in `ask-assets-v1`. A first save also stores the PDF
library and, if it is missing, the answer library, so a saved document opens offline with both its pages and
its text. The Save button shows the document's size, and the answer library's when a first save will store it
too. Each file is fetched whole and the page waits for each write, so a full disk is reported, and older copies
are deleted only after the new one is stored. The Documents page lists the 21 guides as saved or not, with
their sizes. It saves the rest one at a time, with a Stop, marks a saved guide that has since been updated, and
removes one or, after a confirmation, all.

**Why this project uses it.** Storage belongs to the user, and offline reading is a promise the app makes.

**Tradeoffs accepted.** Nothing is offline until the user saves it. A guide updated after it was saved needs
saving again; until then the older copy stays readable.

## How These Pieces Fit Together

An answer card opens the reader at its cited page. PDF.js, loaded only then, draws the official document; the
matcher marks the passage the corpus build anchored; and the place-keeping holds the view steady through
resizes. The Text view stands behind every failure. Saving puts the document and the libraries it needs into
the cache that outlives releases, so the same citation opens with no connection.

## Standards Adopted in This Section

- **The official document, at the cited page.** Every PDF citation opens it, with the passage marked.
- **No wrong mark.** A passage that cannot be found is named, not guessed.
- **Viewing keeps nothing**; only the user's Save stores a document.
- **A fallback for every failure**: the Text view.
- **The PDF library loads only when a document opens.**

## Further Reading

- PDF.js: https://mozilla.github.io/pdf.js/
- The dialog element: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog
- W3C text quote selectors: https://www.w3.org/TR/annotation-model/#text-quote-selector
- ResizeObserver: https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver
- Cache API: https://developer.mozilla.org/en-US/docs/Web/API/Cache

## Revision Notes

- 2026-10-02: First draft.
