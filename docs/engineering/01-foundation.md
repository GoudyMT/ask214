# Foundation - Engineering Decisions

## Overview

The foundation phase establishes the development environment, build pipeline, and code-quality automation the rest of the project depends on. The decisions captured here govern every subsequent component build: language, framework, package manager, test stack, CI path, hosting, and license.

## Stack at a Glance

| Layer                  | Tool                | Version    | Purpose                                              |
| ---------------------- | ------------------- | ---------- | ---------------------------------------------------- |
| Framework              | SvelteKit           | 2.x        | Full-stack Svelte 5 application framework            |
| Language               | TypeScript          | 6.x        | Strict type checking across all source code          |
| Package manager        | pnpm                | 11.x       | Disk-efficient, fast, reproducible installs          |
| Build / bundler        | Vite                | 8.x        | Bundled with SvelteKit                               |
| Unit + component tests | Vitest              | 4.x        | Native Vite integration; browser mode via Playwright |
| End-to-end tests       | Playwright          | 1.59.x     | Cross-browser E2E (Chromium / Firefox / WebKit)      |
| Linting                | ESLint              | 10.x       | TypeScript + Svelte rules                            |
| Formatting             | Prettier            | 3.x        | Consistent code style                                |
| Pre-commit hooks       | Husky + lint-staged | 9.x / 17.x | Block commits that violate lint, types, or tests     |
| Node version manager   | fnm                 | 1.39.x     | User-space Node management; auto-switch via `.nvmrc` |
| Hosting                | Cloudflare Pages    | n/a        | Static PWA hosting with edge distribution            |
| License                | AGPL-3.0            | n/a        | Strong copyleft for a public-good codebase           |

## Decisions and Reasoning

### SvelteKit + Svelte 5

**What it is.** SvelteKit is a full-stack web framework built on Svelte 5. It handles routing, server-side rendering, prerendering, and bundling. Svelte itself is a compiler-driven UI framework that produces small runtime bundles by shifting work to build time.

**Why this project uses it.** The product ships as a Progressive Web App with offline-first capability and an on-device retrieval pipeline in a later phase. Bundle size matters: smaller bundles mean faster first load on mobile, less context to cache for offline-first, and lower memory pressure when the local ML inference path arrives. Svelte produces a ~20-40 KB runtime — meaningfully smaller than React (~140 KB) or Vue (~80 KB).

**Considered alternatives.** Next.js (largest ecosystem, but server-rendering optimizations are misaligned with an offline-first model). SolidStart (similarly small bundles, smaller ecosystem, fewer Cloudflare adapters at production-readiness). Astro (excellent for content sites; our interactivity model is closer to a single-page app).

**Tradeoffs accepted.** Smaller hiring pool than React. Some libraries assume React/Vue and need adapters. Svelte 5 runes are recent and best practices are still solidifying.

### TypeScript with strict mode

**What it is.** TypeScript is a typed superset of JavaScript. Strict mode enables checks that prevent common runtime errors: null/undefined access, implicit any, unsafe casts.

**Why this project uses it.** The product handles user PII (encrypted at rest), authentication tokens, and a content retrieval pipeline. Type errors that escape to runtime in any of these paths can corrupt data, leak credentials, or surface wrong information. Strict types catch a large class of these bugs at compile time.

**Tightened beyond SvelteKit defaults.** Three additional flags enabled: `noUncheckedIndexedAccess` (array/object access returns `T | undefined` instead of `T`), `noImplicitOverride` (method overrides must be explicit), `noFallthroughCasesInSwitch` (switch cases must terminate or fall through deliberately).

**Tradeoffs accepted.** Friction during prototyping. Some library types are wrong and require local workarounds.

### pnpm

**What it is.** A package manager that uses a content-addressable global store and hardlinks packages into each project's `node_modules`. Faster than npm, more disk-efficient than yarn.

**Why this project uses it.** Strict dependency resolution catches missing-peer-dependency bugs before CI. Hardlinked store means installing 200 packages takes seconds. Lockfile is more deterministic than npm's. SvelteKit, Vite, and the modern JavaScript ecosystem support pnpm as a first-class option.

**Considered alternatives.** npm (slower, less strict). yarn (modern versions improved but pnpm still wins on disk and reproducibility).

**Tradeoffs accepted.** Some legacy tooling expects npm's flat `node_modules` layout and surfaces phantom-dependency errors under pnpm's stricter structure.

### Vitest + Playwright

**What they are.** Vitest is a Vite-native test runner for unit and component tests. Playwright is an end-to-end browser automation framework that drives Chromium, Firefox, and WebKit.

**Why this project uses them.** Vitest reuses Vite's transformer, so test code paths match production code paths exactly. Playwright's cross-browser support catches PWA quirks that single-browser tools miss. Together they cover: pure logic (Vitest in Node), component rendering (Vitest in Playwright-driven browser mode), and full user journeys (Playwright directly).

**Considered alternatives.** Jest + Cypress (the previous mainstream pair; Jest has weaker Vite integration; Cypress lags Playwright on cross-browser support and speed).

**Tradeoffs accepted.** Playwright's browser downloads are ~600 MB total across Chromium, Firefox, and WebKit. One-time cost. Vitest's browser-mode component tests require Playwright installed even for unit-test runs.

### ESLint + Prettier

**What they are.** ESLint is a static analyzer that flags code-quality issues. Prettier is an opinionated formatter that normalizes style.

**Why this project uses them.** Solo development without these is fine for a week and degrades over months. Lint catches real bugs (unused variables, async/await mistakes, accessibility issues). Prettier eliminates style debates. Both run on every commit via the pre-commit hook.

**Tradeoffs accepted.** Two tools instead of one. Configuration overhead when their rules conflict (minimal with the prettier-eslint integration).

### fnm (Fast Node Manager) + Node 22 LTS

**What it is.** fnm is a Rust-built Node version manager that lives in user space (no admin required). Node 22 is the current Long-Term Support version, maintained through April 2027.

**Why this project uses fnm.** The default Node install (system-wide at `C:\Program Files\nodejs` on Windows) requires administrator privileges for every global package install. fnm shifts Node into user space and auto-switches versions when entering a project with a `.nvmrc` file. This eliminates permission friction across the build.

**Considered alternatives.** nvm-windows (slower, separate binaries per Node version). Volta (auto-switches via `package.json` instead of `.nvmrc`; less common in CI). System Node + npm prefix to user dir (works, but considered an anti-pattern by the community).

**Tradeoffs accepted.** One additional tool to install. PowerShell profile must self-bootstrap fnm's directory in case Windows User PATH does not propagate to fresh shells — an issue encountered during the actual setup.

### Husky + lint-staged

**What they are.** Husky manages Git hooks. lint-staged runs commands only against files staged for commit. Together they create a pre-commit pipeline.

**Why this project uses them.** Solo development means no peer reviewer catches "I committed broken code." The pre-commit hook runs lint, type-check, and unit tests on every commit attempt. A commit that violates any of those is blocked. This is the safety net that compensates for the absence of a teammate.

**Pipeline.** `lint-staged` (lints + formats staged files only) -> `pnpm run check` (TypeScript) -> `pnpm run test:unit` (Vitest). If any step fails, the commit is rejected.

**Tradeoffs accepted.** Each commit takes 10-15 seconds while the hook runs. Acceptable for solo development; revisitable as the test suite grows.

### Cloudflare Pages

**What it is.** A static site hosting service with global edge distribution and integrated Workers (serverless functions).

**Why this project uses it.** Generous free tier (unlimited bandwidth, 500 builds per month) covers expected scale through v1.0 launch. Native SvelteKit adapter (`@sveltejs/adapter-cloudflare`) means deploying is a configuration choice, not a porting effort. When the project needs a backend later (for the synthesis API proxy), Workers run on the same platform without migration overhead.

**Considered alternatives.** Vercel (excellent developer experience but more likely to surprise with bills at scale). Netlify (similar to Vercel, smaller CDN footprint).

**Tradeoffs accepted.** Some advanced features (deep edge caching, KV-namespace integration) require Cloudflare-specific patterns that do not transfer if the project ever moves hosts.

### AGPL-3.0 License

**What it is.** The GNU Affero General Public License v3.0 is a strong copyleft license. Anyone running a modified version as a service must publish their modifications under the same terms.

**Why this project uses it.** This is a public-good codebase serving transitioning service members. AGPL prevents commercial competitors from forking the code, polishing it privately, and outrunning the original without contributing back. The license is recognized by GitHub, OSI, and FSF.

**Considered alternatives.** MIT (maximally permissive, allows commercial closure). Apache 2.0 (permissive with patent grant). BSD (similar to MIT).

**Tradeoffs accepted.** Some contributors avoid AGPL projects. Some commercial relationships are harder to structure. Both acceptable for a public-good project.

## How These Pieces Fit Together

The foundation prioritizes speed of iteration without compromising reliability. SvelteKit + Vite + Vitest share a single transformer pipeline, so the test runner sees exactly what production sees. pnpm and strict TypeScript catch errors before they reach CI. Husky and lint-staged catch errors before they reach the repository. Playwright catches errors before they reach users.

The stack also assumes solo development without compromising on quality. The pre-commit hook is the human reviewer that does not exist. Strict TypeScript is the peer who would have caught the null dereference. Vitest's browser mode replaces the manual component check a QA team would normally perform. Each automation closes a gap that a small team would normally close with people.

Cloudflare Pages was chosen for cost (free at expected scale) and native SvelteKit support (no porting overhead). The AGPL license guards the project against commercial fork-and-outrun.

## Standards Adopted in This Section

- **Test-Driven Development.** Tests written before or alongside implementation. Acceptance criteria live in test files, not in comments.
- **No commit bypasses.** The pre-commit hook is the safety net. The `--no-verify` flag is reserved for genuine emergencies.
- **Strict TypeScript.** No `any` without justification. No silent unchecked indexed access.
- **Conventional commit messages.** Type prefix (`feat` / `fix` / `chore` / `refactor` / `test` / `docs` / `security`) + scope + imperative summary.
- **Public source code with selective documentation.** Code and outward-facing decision documents are tracked publicly. Operational documents (drafts, ADRs in progress, session logs) are kept locally.

## Further Reading

- SvelteKit: https://kit.svelte.dev/
- Svelte 5 (with runes): https://svelte.dev/docs/svelte/overview
- TypeScript strict mode options: https://www.typescriptlang.org/tsconfig#strict
- pnpm: https://pnpm.io/
- Vitest browser mode: https://vitest.dev/guide/browser/
- Playwright: https://playwright.dev/
- fnm: https://github.com/Schniz/fnm
- Husky: https://typicode.github.io/husky/
- Cloudflare Pages: https://developers.cloudflare.com/pages/
- AGPL-3.0 reference: https://www.gnu.org/licenses/agpl-3.0.en.html

## Revision Notes

- 2026-05-22 (initial draft): Phase 0 foundation decisions captured at Tasks 0.1-0.6. Final polish at Phase 0 completion will incorporate lessons from the remaining Tasks 0.7-0.10 (CI, GitHub repo, Cloudflare Pages deploy, ADR authoring).
