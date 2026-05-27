# Base PWA Scaffold - Engineering Decisions

## Overview

Phase 1 builds the privacy-first PWA application shell on top of the foundation: design tokens, accessible root layout, installable manifest, offline-capable service worker, strict Content Security Policy, Cloudflare security headers, and CI gates for accessibility and bundle size. Feature development from Phase 2 forward inherits this shell - every route renders inside the locked layout, every UI runs against the locked CSP, every commit ships through the same gates.

## Stack at a Glance

| Layer                  | Tool                          | Version   | Purpose                                                        |
| ---------------------- | ----------------------------- | --------- | -------------------------------------------------------------- |
| Design tokens          | TypeScript registry           | n/a       | Single source for palette, spacing, type, motion               |
| CSS architecture       | CSS custom properties         | n/a       | Token values exposed as `--var` for runtime override           |
| PWA shell              | Web App Manifest              | spec      | Install on iOS Safari / Android Chrome / desktop browsers      |
| Offline support        | Service Worker                | spec      | Cache-first built assets + network-first pages                 |
| Security policy        | SvelteKit auto-CSP            | hash mode | Hash-allowlisted inline scripts; no `unsafe-inline`            |
| Edge headers           | Cloudflare `_headers`         | spec      | HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy |
| Responsible disclosure | `/.well-known/security.txt`   | RFC 9116  | Standardized security contact                                  |
| Bundle budget          | size-limit + @size-limit/file | 12.x      | Per-glob gzip byte budget enforcement                          |
| Accessibility gate     | Lighthouse CI                 | 0.15.x    | Lighthouse on every build; a11y >= 0.95 fails CI               |

## Decisions and Reasoning

### Design tokens (typed registry + CSS variables)

**What they are.** A typed TypeScript registry (`src/lib/styles/tokens.ts`) paired with a CSS custom-property layer (`src/app.css`) generated from the same values - one source for palette, spacing, type, and motion.

**Why this project uses them.** A PWA shipping to mobile, tablet, and desktop needs visual consistency without per-component overrides. Tokens let components reference `var(--color-accent)` while the registry holds the meaning. When brand identity is locked closer to launch, one file update propagates everywhere.

**Tradeoffs accepted.** The registry and the CSS variables are two sources of the same information that must stay in sync. A small unit test verifies structural alignment, but the discipline is human. Acceptable for a one-developer project; revisitable when contributors arrive.

---

### Layout + accessibility landmarks

**What it is.** A sticky-header layout with text wordmark, right-aligned navigation, a `<main>` content region, and a 2-line footer. Semantic HTML5 elements carry explicit ARIA landmark roles. The first focusable element is a keyboard-revealed skip-to-content link.

**Why this project uses it.** The target audience - transitioning service members with a range of disabilities - makes accessibility a baseline requirement, not a polish item. The skip link supports screen-reader and keyboard-only users; explicit landmarks let assistive technologies expose page structure even when stylesheets fail to load.

**Tradeoffs accepted.** Explicit `role="banner"`, `role="main"`, `role="contentinfo"` duplicates the implicit semantics of HTML5 landmarks. The verbose pattern survives across user-agent quirks more reliably than implicit alone - accepted as defensive markup.

---

### Responsive design (bandwidth-mode partially shipped)

**What actually shipped.** Mobile-first CSS with fluid typography via `clamp()`, a 720px container max-width on content routes, and breakpoint Playwright tests at 320 / 375 / 414 / 768 / 1024 / 1280 px. Low-bandwidth visual defaults (system fonts, solid background, no decorative images, no animations) are unconditionally in effect via the design-token layer (Task 1.2).

**What did NOT ship.** The "bandwidth-mode architecture" described in ADR-010 - `body[data-bandwidth-mode="low"]` selector pattern, localStorage hook, JS toggle, container queries (`@container`) - did NOT land in Phase 1. An 8-line CSS comment described the pattern; no implementing code was written. ADR-010 status revised to `partially implemented` (audit T6-A, Session 10).

**Why what shipped works.** Fluid typography eliminates the breakpoint-and-pray pattern of fixed-pixel design. Low-bandwidth visual defaults serve service members on constrained data plans, transient shared Wi-Fi, or patchy mobile coverage - by being the unconditional baseline rather than a toggle-gated variant. The audience that benefits gets it whether they toggle anything or not.

**Tradeoffs accepted.** No bandwidth-mode toggle in v1.0; users get the low-bandwidth-by-default visual baseline by default. When a future component needs differentiated heavy/light treatment, the selector pattern + toggle UI will be authored at that time per ADR-010's recorded design ([`docs/decisions/010-responsive-design.md`](../decisions/010-responsive-design.md)). Building the architecture without the payload would have been chrome without value.

---

### PWA manifest + maskable icons

**What it is.** A Web App Manifest at `static/manifest.webmanifest` declares name, start URL, `standalone` display mode, theme color, and the 192x192 + 512x512 icons required for installable status. Icons are marked `purpose: "maskable any"` so adaptive-icon platforms can crop without clipping.

**Why this project uses it.** PWA install is a retention surface: an installed app on the home screen survives the casual browser-tab churn that kills web-app revisits. Standalone display matches the user's expectation of "an app".

**Tradeoffs accepted.** v1.0 dev ships placeholder solid-color PNGs - visually neutral, structurally correct. Real branded artwork is a launch blocker before public release; placeholders unblock developer iteration without front-loading brand work that may shift.

---

### Service worker (offline shell)

**What it is.** A service worker at `src/service-worker.ts` installs on first visit and handles fetch events with a cache-first strategy for built assets and a network-first strategy for HTML pages with an offline fallback. Cache names embed a build hash so each deploy rotates caches.

**Why this project uses it.** Offline-first is core to the product thesis. A service member opening the app on a flight, in a barracks dead zone, or on a base with unreliable internet should see the shell render and last-known content load, degrading gracefully rather than failing loudly.

**Considered alternatives.** Workbox (heavier, more configurable; overkill). Vite PWA plugin (opinionated; reduces visibility into the cache logic). The hand-rolled SW that shipped is ~80 lines with zero transitive dependencies.

**Tradeoffs accepted.** Cache-first on assets means a freshly deployed build is invisible to a user with an already-loaded tab until cache rotation runs. Cache-name-per-build mitigates by ensuring fresh sessions immediately load the new build; an in-app "update available" UI is a Phase 2 enhancement.

---

### Content Security Policy (auto-CSP hash mode)

**What it is.** A strict CSP with 12 directives - `default-src 'self'`, `script-src 'self' 'sha256-...'`, `object-src 'none'`, `frame-ancestors 'none'`, `upgrade-insecure-requests` - generated by SvelteKit's auto-CSP feature in `hash` mode.

**Why this project uses it.** The OWASP ASVS Level 2 baseline requires a meaningful CSP, and the project's privacy-first stance forbids `unsafe-inline`. A manual `<meta http-equiv="Content-Security-Policy">` with strict `script-src 'self'` silently breaks SvelteKit hydration - the framework's inline script lacks an allowlist entry. Auto-CSP hashes the framework's own inline scripts at build time, producing a strict policy that still permits operation.

**Tradeoffs accepted.** Future features that need inline scripts (rare; usually wrong) require design review to compute hashes at build time or refactor to external files. The strictness is the point; ergonomic loss is the cost of XSS-resistance.

---

### Cloudflare `_headers` + responsible disclosure

**What it is.** A `_headers` file (at project root - adapter-cloudflare 7.x errors if placed in `static/`) specifies HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and a Content-Type pin on security.txt. A `/.well-known/security.txt` per RFC 9116 lists a reachable security contact via GitHub Security Advisory URL (not email - the temporary `.workers.dev` subdomain lacks MX records).

**Why this project uses them.** Defense in depth - CSP closes XSS at the browser; security headers close transport and framing attacks at the edge. RFC 9116 publishes the disclosure path in a standardized location researchers know to check.

**Tradeoffs accepted.** The `_headers` rules have no automated CI coverage; they take effect only at Cloudflare deploy time. Deferred hardening items (CSP reporting endpoint, COEP, HSTS preload ramp-up) are documented in ADR-011 ([`docs/decisions/011-deferred-security-hardening.md`](../decisions/011-deferred-security-hardening.md)) with trigger conditions for the v1.1+ backend phase.

---

### CI gates - size-limit + Lighthouse

**What they are.** `size-limit` (with `@size-limit/file`) enforces per-glob gzip byte budgets on built JavaScript bundles, failing CI if any glob exceeds its limit. Lighthouse CI runs against the preview build at two URLs, with accessibility as an error gate (minScore 0.95) and other categories as warnings.

**Why this project uses them.** Bundle size is privacy-adjacent - a smaller bundle means less to leak through service-worker cache, faster first paint on slow networks, and lower memory pressure when the local ML path arrives. Accessibility regressions are subtle and easy to ignore without an enforced gate.

**Tooling history.** The first cut shipped with `bundlesize`, which last published in 2019 and ships a native Brotli dependency (`iltorb`) that pnpm 11's strict ignored-builds policy hard-errors on. The swap to `size-limit` resolves the blocker permanently and measures per-glob total (not per-file), catching the chunk-splitting failure mode the older tool would miss.

**Tradeoffs accepted.** Lighthouse uploads reports to Google's `temporary-public-storage` bucket - no PII in reports, but third-party touchpoints exist. A switch to `filesystem` target is planned before public launch.

## How These Pieces Fit Together

The Phase 1 shell layers privacy, accessibility, and resilience without conflict. Design tokens give the visual language; layout and landmarks make it accessible; responsive + bandwidth-mode foundation make it usable across the connectivity range a service member actually encounters. The manifest and service worker turn the page into an installable, offline-capable surface.

Strict CSP and Cloudflare security headers form the first line of XSS and transport defense; the responsible disclosure path opens a channel to security researchers. CI gates close the loop - every push enforces accessibility and bundle budget before the change reaches the user. The shell is what the user notices last and what fails most catastrophically; every decision here optimizes for invisible-when-working, visible-when-broken.

## Standards Adopted in This Section

- **Accessibility as gate.** Lighthouse a11y minScore 0.95 is an error in CI. Regressions block merge.
- **Strict CSP via framework auto-CSP.** SvelteKit projects use `kit.csp.mode = 'hash'`; manual meta-tag CSP is reserved for static sites without dynamic hydration.
- **Responsible disclosure published.** Every deploy includes `/.well-known/security.txt` with a reachable contact.
- **Bundle budgets at design time.** Bumping budgets to silence regressions is forbidden.
- **Edge security headers via `_headers`.** All HTTP security headers live in the project-root `_headers` file, not the framework's HTML output.

## Further Reading

- Web App Manifest: https://developer.mozilla.org/en-US/docs/Web/Manifest
- Service Worker API: https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API
- SvelteKit Content Security Policy: https://kit.svelte.dev/docs/configuration#csp
- RFC 9116 (security.txt): https://www.rfc-editor.org/rfc/rfc9116
- OWASP Application Security Verification Standard: https://owasp.org/www-project-application-security-verification-standard/
- Cloudflare Workers Assets `_headers`: https://developers.cloudflare.com/workers/static-assets/headers/
- Lighthouse accessibility audits: https://developer.chrome.com/docs/lighthouse/accessibility/
- size-limit: https://github.com/ai/size-limit

## Revision Notes

- 2026-05-26 (initial draft): Phase 1 Base PWA Scaffold decisions captured at Tasks 1.1-1.7.
