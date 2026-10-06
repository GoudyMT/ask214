# Base PWA: Engineering Decisions

## Overview

The base PWA is the shell every page of Ask 214 renders inside: design tokens and themes, the layout, the
install manifest, the service worker, the Content Security Policy, the edge headers and the budgets. Each
decision's full reasoning is kept in private working notes.

## Stack at a Glance

| Layer             | Tool                               | Version  | Purpose                                 |
| ----------------- | ---------------------------------- | -------- | --------------------------------------- |
| Tokens and themes | TypeScript registry, CSS variables | n/a      | Colour, spacing, type; light and dark   |
| Install           | Web App Manifest                   | spec     | Home screen install                     |
| Offline           | Service Worker                     | spec     | Opens with no connection                |
| Script policy     | SvelteKit CSP, hash mode           | 2.x      | Only named scripts run                  |
| Edge headers      | Cloudflare `_headers`              | n/a      | Transport, framing, referrer, isolation |
| Disclosure        | `security.txt`                     | RFC 9116 | Where to report a vulnerability         |
| Budgets           | size-limit, `check:chunks`         | 13.x     | Gzipped size limits                     |
| Quality gate      | Lighthouse CI                      | 0.15.x   | Accessibility and performance in CI     |

## Decisions and Reasoning

### Design tokens and themes

**What they are.** `src/lib/styles/tokens.ts` is a typed registry of colours, spacing, radii, fonts and type
sizes; `src/app.css` exposes the same values as CSS custom properties, so components use names, never hex
codes. A palette change is one edit.

**Themes.** The app follows the device's light or dark setting unless the user picks one in Settings. An inline
script in `src/app.html` applies a saved choice before the first paint, so there is no flash of the wrong
theme. It uses system fonts, so no web fonts download.

**Tradeoffs accepted.** The registry and the stylesheet hold the same values twice. A unit test
(`src/lib/styles/contrast.test.ts`) checks that the stylesheet's light values match the registry and that text
meets WCAG AA contrast (4.5:1, and 3:1 for interface edges) in both themes.

---

### Layout and accessibility

**What it is.** One layout wraps every page: a sticky header with the wordmark and navigation, a `main` region,
and a footer with the not-affiliated statement and links to About, Source and Feedback. A "Skip to content" link
comes first in keyboard order. The landmarks are plain `header`, labelled `nav`, `main` and `footer` elements,
which carry their roles natively.

**Why this project uses it.** Many users live with a disability, so keyboard and screen reader support is a
baseline. The drifting row of example questions on the Ask screen has a pause button, pauses on hover or focus,
and stays still when the device asks for reduced motion.

**Responsive design.** Every page uses one 900 px column (`src/lib/layout/shell-width.ts`) that goes full width
on smaller screens, and headings scale with `clamp()`. Playwright checks the home page at six widths from 320 to
1280 px and the other public pages at three phone widths, in Chromium and WebKit: the landmarks must render and
nothing may scroll sideways.

**Tradeoffs accepted.** Wide screens are partly empty; the gain is one layout to build and test.

---

### Manifest and install

**What it is.** `static/manifest.webmanifest` opens the app as a standalone window in portrait, sets the theme
colour, and lists 192 and 512 px icons marked `any maskable`, so Android can crop them to its own shape. A
second inline script in `app.html` keeps the browser's one-time install event, which can fire before the app
loads, so the app can offer its own Install button later.

**Tradeoffs accepted.** That event exists only in Chromium-based browsers; elsewhere, installing goes through
the browser's own menu.

---

### Service worker

**What it is.** `src/service-worker.ts`, with its rules in `src/lib/ask/asset-cache.ts`. Install stores the
built app, the small static files and the home page in a cache named for the release (`app-<version>`), which
the next release deletes. Files loaded only on demand (the on-device model and its runtime, the answer library,
the PDF library, saved documents) go to a second cache, `ask-assets-v1`, whose name never changes, so updates do
not download them again; each release prunes the old versions nothing will request again.

**How it answers.** Same-origin GET requests only, and nothing under `/api/` is ever stored. Built files come
from the cache first. Everything else comes from the network first and falls back to the stored copy; a page
with no stored copy falls back to the home page, whose router draws the page asked for. Pages that show personal
data render only in the browser (`ssr = false`, required by a unit test), so no stored page holds anything of
the user's.

**Considered alternatives.** Workbox and the Vite PWA plugin. These rules are specific enough (a cache that
outlives releases, saved documents carried forward) that hand-written, unit-tested logic is easier to verify.

**Tradeoffs accepted.** About 830 lines of caching code to maintain. A new release takes over only after every
tab of the old one has closed; there is no "update available" prompt yet.

---

### Content Security Policy

**What it is.** SvelteKit builds the policy from `kit.csp` in `svelte.config.js`, in hash mode: each inline
script it writes is allowed by its SHA-256 hash, so scripts never need `'unsafe-inline'`. Of its 13 directives,
the ones that matter most:

- `default-src 'self'`: nothing loads from another site unless a directive says so.
- `script-src`: the app's own files, SvelteKit's hashes, two hand-pinned hashes for the scripts in `app.html`,
  and `'wasm-unsafe-eval'`, which lets the on-device model's WebAssembly compile without allowing `eval()`.
- `connect-src`: the app's own origin and one outside address, `https://api.anthropic.com/v1/messages`, used
  only after the user turns on the written summary with their own key.
- `object-src 'none'`, `frame-ancestors 'none'` and `upgrade-insecure-requests`.

**Why this project uses it.** It makes the browser enforce the privacy claims: even injected code cannot reach
an unnamed site through a script, image, font, frame or form.

**Tradeoffs accepted.** Editing either `app.html` script means recomputing its hash. Styles still allow
`'unsafe-inline'`; removing it is open work.

---

### Security headers and disclosure

**What it is.** Cloudflare applies `_headers` (project root) at the edge. Every response carries two-year HSTS
with `includeSubDomains` and `preload`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, a `Permissions-Policy` that turns off the camera, microphone, location and
interest cohorts, and same-origin `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy`. The pages
that hold personal data (`/`, `/wizard`, `/settings`, `/timeline`) send `Cache-Control: no-store`, so the
browser does not keep them, decrypted, in its back-forward cache. The served documents send
`X-Robots-Tag: noindex`, and the PDF library's worker runs under `default-src 'none'`, so it cannot make
requests of its own.

**Disclosure.** `/.well-known/security.txt` (RFC 9116) points to GitHub's private vulnerability report form and
expires on 2027-05-22. `wrangler.toml` sets `workers_dev = false`, so the app is served only from ask214.com.

**Tradeoffs accepted.** End-to-end tests cannot see these headers, because `vite preview` ignores `_headers`.
A unit test pins every value in the file (`src/lib/ci/headers-policy.ts`), but nothing in CI reads what the
live site sends.

---

### Budgets and Lighthouse

**What they are.** `size-limit` caps the gzipped JavaScript: the SvelteKit entry at 10 KB, the root layout
loaded on every page at 7,040 bytes, and the code of all pages together at 45,040 bytes. `pnpm check:chunks` caps what
one page downloads (59,320 bytes), the code loaded on demand (7,300 bytes) and the service worker's install set
(60 files, 144,480 bytes), all gzipped. Lighthouse CI runs three times against `/` and `/about` on the
production build: accessibility below 0.95 or performance below 0.9 fails the build, and best practices or SEO
below 0.9 warns. Reports stay in a CI artifact.

**Why this project uses them.** Every byte the shell ships is downloaded, stored offline and held in memory
beside the on-device model, so growth must be a decision. Accessibility regressions are easy to miss without a
gate.

**Tradeoffs accepted.** A feature that does not fit waits for a trim or an explicit decision to raise the limit,
never a quiet raise. Lighthouse scores two pages, not all of them.

## How These Pieces Fit Together

The tokens and the layout make every page consistent and accessible. The manifest and the service worker make an
app that installs and opens offline, with no personal data in any stored page. The policy and the headers let
the browser enforce the privacy claims, and the budgets hold it all to a measured size.

## Standards Adopted in This Section

- **Accessibility is a gate**, in CI and in unit tests.
- **No inline script without a hash.**
- **No personal data in stored pages.**
- **Security headers live in `_headers`**, pinned by a test.
- **Budgets are never raised to silence a failure.**

## Further Reading

- Web App Manifest: https://developer.mozilla.org/en-US/docs/Web/Manifest
- Service Worker API: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- SvelteKit CSP configuration: https://svelte.dev/docs/kit/configuration#csp
- Cloudflare `_headers`: https://developers.cloudflare.com/workers/static-assets/headers/
- RFC 9116 (security.txt): https://www.rfc-editor.org/rfc/rfc9116
- OWASP ASVS: https://owasp.org/www-project-application-security-verification-standard/
- size-limit: https://github.com/ai/size-limit
- Lighthouse CI: https://github.com/GoogleChrome/lighthouse-ci

## Revision Notes

- 2026-05-26: First draft, the Phase 1 shell.
- 2026-10-02: Updated to the shipped shell and cut to the word cap.
