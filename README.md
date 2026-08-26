# Ask 214

> Private, offline-first answers for your military transition -- from sources you can trust.

**[Try it at ask214.com](https://ask214.com)**

[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-3a6ea5.svg)](LICENSE)
![PWA: offline-first](https://img.shields.io/badge/PWA-offline--first-5a3e9e.svg)
![Built with SvelteKit](https://img.shields.io/badge/built%20with-SvelteKit-ff3e00.svg)
![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)

**Ask 214** is a privacy-first Progressive Web App for U.S. service members navigating the roughly
24-month window before and after separation. It consolidates the guidance that is scattered across
`.mil` sites, VA pamphlets, and PDF downloads into one installable app that works offline and keeps
your personal information on your device.

The mobile-app layer for transition support has been effectively vacant since Military.com's Transition
App was discontinued around 2017-2018. Ask 214 fills that gap -- built by a U.S. Navy veteran who made
the transition it is designed to help with.

---

## What it does

**v1.0 features** -- the roadmap grows from here (see [Project status](#project-status)):

- **Ask (two modes).** Type a question and get answers with the exact official source on every result.
  - _Offline_ -- retrieval-with-citations runs entirely on your device; nothing leaves it.
  - _Online (opt-in)_ -- a cited, written synthesis via a stateless, zero-retention backend, using your
    own API key. Off by default; the query only leaves the device when you choose to turn it on.
- **Timeline.** A persona-aware, separation-date-anchored checklist of transition tasks. Mark done,
  skip, snooze, or add private notes; export any task to your calendar as an `.ics` file.
- **Resources.** A curated hub of official outbound links (VA, DoD, DOL, TSP, SkillBridge). We link to
  the real government tools with context -- we never recreate or replace them.
- **Offline reference library.** TAP curriculum, VA guides, and agency pages -- all public U.S.
  Government work. Search runs offline, and each result opens the cited passage in an in-app reader
  (highlighted, no connection needed); the link to the official source is a tap away when you are online.

---

## Privacy and security

Privacy is the architecture, not a setting.

- **Your data stays on your device.** Personal information is stored locally in IndexedDB, encrypted
  with AES-GCM via the Web Crypto API. By default it never touches a server.
- **No third-party JavaScript at runtime. No trackers. No ads -- ever.**
- **Strict Content Security Policy** with no third-party JavaScript. By default the app talks only to
  its own origin; the on-device model is self-hosted, so no third-party CDN is contacted at runtime.
- **The online path is opt-in, stateless, and retains nothing** -- no accounts, no server-side storage
  of your queries or data.
- **Boundaries.** Ask 214 does not provide legal, financial, or medical advice, and does not assist with
  VA claims (per 38 CFR 14.629). For anything affecting your benefits, it links you to accredited
  Veteran Service Organizations and official tools.

---

## Tech stack

- **SvelteKit 2** with **Svelte 5** (runes) and **TypeScript** (strict).
- **Cloudflare Workers** via `adapter-cloudflare` -- static assets plus a stateless backend.
- **On-device embeddings** with [Transformers.js](https://github.com/huggingface/transformers.js)
  (`all-MiniLM-L6-v2`, quantized) on **ONNX Runtime Web** (WebAssembly), served from the app's own
  origin.
- **Installable PWA** -- service worker, offline-first, add-to-home-screen.
- **Testing and quality** -- Vitest (unit + component) and Playwright (end-to-end, Chromium + WebKit);
  ESLint, Prettier, Semgrep, and gitleaks in CI.

---

## Running locally

Requires **Node 22+** and **pnpm** (via Corepack).

```bash
pnpm install
pnpm dev        # dev server at https://localhost:5173
pnpm build      # production build
pnpm preview    # preview the production build over HTTPS
pnpm test       # unit (Vitest) + end-to-end (Playwright)
pnpm lint       # Prettier + ESLint
```

---

## Project status

The v1.0 build is complete and deployed; a public launch is in preparation. v1.0 focuses on one persona
done well -- Navy active-duty enlisted separating at end of service -- with the Ask, Timeline,
Resources, and offline reference library all shipping. Later versions expand to additional branches and
components, a deeper SkillBridge module, and a curated peer-story layer.

---

## License

Licensed under the **GNU Affero General Public License v3.0** -- see [`LICENSE`](LICENSE).

AGPL-3.0 keeps the project and its derivatives open, including versions run as a network service: anyone
who deploys a modified copy must make their source available. As required, the running app links back to
this source from its footer. Third-party components and the public-domain sourcing of the reference
corpus are documented in [`NOTICE`](NOTICE).

---

## Not affiliated

Ask 214 is an independent project. It is **not** affiliated with, endorsed by, or sponsored by the U.S.
Department of Defense, the U.S. Department of Veterans Affairs, or any branch of the U.S. military. All
ingested content is public U.S. Government work (17 USC 105) or used under a properly attributed license.
Ask 214 does not provide legal, financial, or medical advice and does not assist with VA claims. For
official benefits guidance, contact a VA-accredited Veteran Service Organization (DAV, VFW, American
Legion, and others) or va.gov.

---

## Security

Found a vulnerability? Please report it responsibly through the contact in
[`static/.well-known/security.txt`](static/.well-known/security.txt) (GitHub security advisories). Please
do not open a public issue for security reports.
