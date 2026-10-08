# Foundation: Engineering Decisions

## Overview

The foundation is the toolchain every later part of Ask 214 is built on: the language, framework, tests,
checks, hosting, and license.

## Stack at a Glance

| Layer                    | Tool               | Version   | Purpose                                           |
| ------------------------ | ------------------ | --------- | ------------------------------------------------- |
| Framework                | SvelteKit          | 2.x       | Full-stack framework for Svelte 5                 |
| UI                       | Svelte             | 5.x       | Compiled components with runes                    |
| Language                 | TypeScript         | 6.x       | Strict type checking across all source            |
| Package manager          | pnpm               | 11.x      | Strict, reproducible installs, pinned by Corepack |
| Build                    | Vite               | 8.x       | The bundler under SvelteKit                       |
| Unit and component tests | Vitest             | 4.x       | Vite-native; browser mode through Playwright      |
| End-to-end tests         | Playwright         | 1.61.x    | Chromium and WebKit                               |
| Linting                  | ESLint             | 10.x      | TypeScript and Svelte rules, plus project rules   |
| Formatting               | Prettier           | 3.x       | One code style                                    |
| Git hooks                | Husky, lint-staged | 9.x, 17.x | Checks on every commit and every message          |
| Runtime                  | Node               | 22 LTS    | Pinned in `.nvmrc`, managed with fnm              |
| Hosting                  | Cloudflare Workers | n/a       | Static assets and a Worker at the edge            |
| Deploy CLI               | wrangler           | 4.x       | Reads `wrangler.toml`                             |
| License                  | AGPL-3.0           | n/a       | Strong copyleft                                   |

## Decisions and Reasoning

### SvelteKit and Svelte 5

**What it is.** SvelteKit is a full-stack framework that handles routing, rendering, prerendering, and bundling.
Svelte compiles components at build time, so the browser receives a small runtime.

**Why this project uses it.** Ask 214 is an offline-first Progressive Web App that also runs a model on the
device. Every kilobyte is downloaded, cached for offline use, and held in memory beside the model, so a runtime
of 20 to 40 KB matters next to React (about 140 KB) or Vue (about 80 KB).

**Considered alternatives.** Next.js (the largest ecosystem, built around server rendering). SolidStart (small
bundles, fewer production-ready Cloudflare adapters). Astro (strong for content sites; Ask behaves like a
single-page app).

**Tradeoffs accepted.** A smaller hiring pool than React, some libraries need adapters, and Svelte 5 runes are
still young.

---

### TypeScript, strict

**What it is.** TypeScript is typed JavaScript. Strict mode rejects implicit `any`, unchecked `null`, and unsafe
casts.

**Why this project uses it.** The app encrypts personal data at rest, holds an optional API key, and cites
sources by their exact position in a document. A type error that reaches runtime on any of those paths corrupts
data or shows the wrong passage.

**Beyond the defaults.** `tsconfig.json` adds `noUncheckedIndexedAccess` (an indexed read is `T | undefined`),
`noImplicitOverride`, and `noFallthroughCasesInSwitch`.

**Tradeoffs accepted.** Slower prototyping, and occasional local workarounds for wrong library types.

---

### pnpm

**What it is.** A package manager with a content-addressed store that hard-links packages into each project.

**Why this project uses it.** Strict resolution surfaces undeclared dependencies before CI, installs are fast,
and the lockfile is deterministic. Corepack reads `packageManager` in `package.json` (pnpm 11.2.2), so local and
CI installs use the same version.

**Tradeoffs accepted.** Tools that expect npm's flat `node_modules` can report phantom-dependency errors.

---

### Vitest and Playwright

**What they are.** Vitest is a Vite-native test runner. Playwright drives real browsers.

**Why this project uses them.** Vitest uses Vite's own transform, so tests run the code production runs. It
covers pure logic in Node and components in a real Chromium through browser mode. Playwright runs the full user
journeys in Chromium and WebKit; WebKit stands in for Safari on the iPhone, where offline PWA behaviour differs
most.

**Considered alternatives.** Jest and Cypress (weaker Vite integration; slower, narrower browser support).

**Tradeoffs accepted.** A one-time download of the browsers, and browser-mode component tests need Playwright
installed even for unit runs.

---

### ESLint and Prettier

**What they are.** ESLint flags code problems; Prettier formats code. Both run on staged files at every commit
and over the whole repository in CI. Three project rules in `eslint-plugins/` add checks of our own, such as
refusing user input inside a thrown error's message. The tradeoff is two tools and two configurations.

---

### Node 22 and fnm

**What it is.** Node 22 is the Long-Term Support line, maintained to April 2027. fnm is a Node version manager
that runs in user space.

**Why this project uses it.** `.nvmrc` pins Node 22, and fnm switches to it on entering the project, with no
administrator rights needed for global installs on Windows.

**Considered alternatives.** nvm-windows (slower, separate binaries per version). Volta (switches from
`package.json`, less common in CI).

**Tradeoffs accepted.** One more tool, and a PowerShell profile has to load fnm when a new shell does not
inherit its path.

---

### Husky and lint-staged

**What they are.** Husky installs Git hooks; lint-staged runs commands on staged files only.

**The pre-commit hook** runs, in order: lint-staged (ESLint and Prettier on staged files), the sources registry
check, `svelte-check`, the type checks of the content scripts and of the search Worker, and the unit and
component tests. Any failure stops the commit. It takes about a minute on the development machine, most of it
the type check.

**The unit and component tests** run through `content-ops/hook-unit-tests.mjs`, started by `node` itself rather
than through pnpm, and are stopped with everything they started if they are still running after five minutes.
On Git for Windows, a command run through a shell-script launcher (pnpm's, or vitest's own) runs inside one more
shell. Stopping the command fails the commit, as it should, but stopping that shell from outside reads as a
success, and the hook carries on to the commit. Started by `node`, the test run has no such shell. One case
stays open: stopping the hook's own shell can still let the commit land, and stopping the shell behind one of
the pnpm steps skips that step the same way. To stop a hung hook, stop the `git commit` process tree or the
`hook-unit-tests.mjs` node process, never a shell in the chain.

**The commit-msg hook** rejects a message that is not one line of the form `type: subject`. CI checks the same
rule on every commit a pull request carries, because commits Git makes itself skip the hook.

**Tradeoffs accepted.** A minute per commit.

---

### Continuous integration and dependencies

**What it is.** GitHub Actions runs on every push to `main` and every pull request: the dependency audit, lint,
all three type checks, the content checks (sources registry, sources index, served documents, the vendored
pdf.js worker, commit messages), the answer quality gate, unit and end-to-end tests, the build, the citation
highlight gate, the bundle and chunk budgets, and Lighthouse. Semgrep and a gitleaks secret scan run beside it.

**Dependencies.** Dependabot opens grouped pull requests weekly for npm and monthly for GitHub Actions, each
held for seven days after a release. pnpm's `minimumReleaseAge` of 1,440 minutes (in `pnpm-workspace.yaml`)
refuses to resolve any version published in the last day; frozen-lockfile installs trust the reviewed lockfile.

**Tradeoffs accepted.** Some Dependabot updates fail CI and need triage, and new releases arrive a week late.

---

### Cloudflare Workers with static assets

**What it is.** Cloudflare's edge platform: static assets are served from cache, and one Worker handles dynamic
requests.

**Why this project uses it.** The free tier covers the expected load, `@sveltejs/adapter-cloudflare` emits the
Worker and its assets directly, and the online search Worker runs on the same platform.

**Configuration.** `wrangler.toml` sets the Worker name, its entry (`.svelte-kit/cloudflare/_worker.js`), the
compatibility date, and the `nodejs_compat` flag SvelteKit needs. Cloudflare's Git integration builds and
deploys every push to `main`.

**Considered alternatives.** Vercel (excellent tooling, costlier at scale). Netlify (a smaller edge compute
story).

**Tradeoffs accepted.** Platform features such as KV and Durable Objects do not move to another host unchanged.

---

### AGPL-3.0

**What it is.** A strong copyleft license: anyone who runs a modified version as a network service must publish
their changes under the same terms.

**Why this project uses it.** AGPL stops a closed fork from outrunning the original without giving back; the
running app links to its source from the footer.

**Considered alternatives.** MIT, Apache 2.0, and BSD, all permissive.

**Tradeoffs accepted.** Some contributors and companies avoid AGPL projects.

---

### Decision records

Each significant decision is written up as a short record in the project's private working notes. The
engineering documents here are the public summary.

## How These Pieces Fit Together

Strict TypeScript and pnpm stop errors before a commit, the hooks stop them before the repository, CI stops them
before `main`, and Playwright stops them before users. For a solo project, each automated check stands in for a reviewer the team
does not have.

## Standards Adopted in This Section

- **Tests first.** Tests are written before or with the code they cover.
- **No skipped hooks.** `--no-verify` is not used.
- **Strict types.** No `any` without a stated reason.
- **One-line commits.** `type: subject`, where the type is `feat`, `fix`, `refactor`, `test`, `docs`,
  `chore`, `security`, or `perf`; lowercase, imperative, no period, no body.
- **Public code, selective documents.** Code and these documents are public; working notes stay private.

## Further Reading

- SvelteKit: https://svelte.dev/docs/kit
- Svelte 5: https://svelte.dev/docs/svelte/overview
- TypeScript strict options: https://www.typescriptlang.org/tsconfig#strict
- pnpm: https://pnpm.io/
- Vitest browser mode: https://vitest.dev/guide/browser/
- Playwright: https://playwright.dev/
- fnm: https://github.com/Schniz/fnm
- Husky: https://typicode.github.io/husky/
- Cloudflare Workers static assets: https://developers.cloudflare.com/workers/static-assets/
- AGPL-3.0: https://www.gnu.org/licenses/agpl-3.0.en.html

## Revision Notes

- 2026-05-22: First draft, the foundation toolchain.
- 2026-06-13: `minimumReleaseAge` described as it works: it gates resolution, not frozen-lockfile installs.
- 2026-09-30: The commit-message hook and its CI check.
- 2026-10-02: Cut to the word cap and brought up to date: Playwright 1.61 on Chromium and WebKit, the full
  pre-commit hook and its measured time, the newer CI checks.
