import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import adapter from '@sveltejs/adapter-cloudflare';
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { dropWorkerWasm } from './src/lib/ci/drop-worker-wasm';

// The app reads today from the device clock, so both test projects run in one fixed zone: every machine and CI
// read the same day, and a zone behind UTC makes a slip back to the UTC date fail here too. A fixed TZ also lets
// a test that stubs another zone get this one back (Node on Windows ignores a deleted TZ).
const TEST_TIME_ZONE = 'America/Los_Angeles';

// The release the footer names; each release's pull request bumps package.json. The first plugin below writes it into
// the root layout as plain text before Svelte compiles, so the page carries static markup: Svelte sets a `define`
// constant at runtime, 21 B more on every page. The `define` stays for any other code that reads the version.
const { version } = JSON.parse(
	readFileSync(new URL('./package.json', import.meta.url), 'utf-8')
) as {
	version: string;
};

// A real past build stamp, not a round number: a run of zeros compresses smaller than any real stamp and would
// measure the shipped files a few bytes light.
const MEASURE_VERSION = '1793277697344';

export default defineConfig({
	define: { __APP_VERSION__: JSON.stringify(version) },
	// The live site sends no CORS headers on the app's files. Vite's preview adds `Vary: Origin` to every file by
	// default, and the service worker's cache lookups then miss a module script (sent with an Origin header) that
	// install stored without one, so the app would not open offline in the E2E suite though it does on the live site.
	preview: { cors: false },
	// The preview server serves HTTPS off a generated self-signed cert, because the production CSP
	// sends `upgrade-insecure-requests` and browsers that honour it rewrite every asset URL to https.
	// Over plain HTTP that yields a page with no stylesheet at all - which is not a product bug (in
	// production the directive is a no-op, the origin is already HTTPS) but does make the E2E suite
	// unable to test the app as it actually ships. The cert is generated on demand and never written
	// to the repo; a checked-in private key is a liability that protects nothing.
	plugins: [
		{
			name: 'app-version',
			enforce: 'pre',
			transform: (code, id) =>
				id.endsWith('/src/routes/+layout.svelte')
					? code.replaceAll('{__APP_VERSION__}', version)
					: null
		},

		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true,

				// Off: every compiled component would otherwise import a module that records Svelte's version on
				// window.__svelte for outside tools. Nothing here reads it, and each import costs page bytes.
				discloseVersion: false
			},
			adapter: adapter(),
			version: {
				// The build time is the version by default, and every hashed file name that leads to it changes with it,
				// so two builds of the same code differ by a few bytes. CI and the gate set MEASURE_BUILD=1 to measure
				// the size budgets with one fixed version. A live build keeps SvelteKit's default: it is stamped once per
				// build, where a time computed here could be computed again for each part of the build, and the service
				// worker and the page would then carry different versions and never agree on an update.
				...(process.env.MEASURE_BUILD === '1' && { name: MEASURE_VERSION }),
				// Off: the hourly timer. The service worker owns updates (the layout's take-over). SvelteKit still fetches
				// the version file each time the app comes back into view (window focus, the tab shown again); no
				// setting turns that off, and the worker keeps no copy of it.
				pollInterval: 0
			},
			// Off: the layout registers /service-worker.js itself, as a module worker, just before it runs the
			// take-over that follows a database raise; SvelteKit's own registration would only repeat that call.
			serviceWorker: { register: false },
			csp: {
				// Hash mode generates SHA hashes for SvelteKit's inline hydration scripts and
				// injects them into script-src - avoids 'unsafe-inline' on scripts. Style-src
				// keeps 'unsafe-inline' for Svelte's per-component <style> blocks (deferred to
				// v1.1 cleanup via the same hash mechanism).
				mode: 'hash',

				directives: {
					'default-src': ['self'],
					// 'wasm-unsafe-eval' lets the embedding worker compile the self-hosted ONNX WASM;
					// it does NOT permit JS eval(). connect-src stays 'self' - no third-party fetch.
					// The two sha256 hashes pin the hand-added inline scripts in src/app.html: the pre-paint
					// theme script (sets data-theme before first paint to avoid a wrong-palette flash) and the
					// early install-prompt capture (stashes beforeinstallprompt before hydration). Hash mode
					// auto-hashes only SvelteKit's own inline scripts, so a hand-added <head> script must be
					// pinned here by hand; recompute if either script's bytes change.
					'script-src': [
						'self',
						'wasm-unsafe-eval',
						'sha256-PTImSrhvB2j8WuYiUGnYhan7q+Hc/ZFGv5riOPKpqpY=',
						'sha256-KRU6Jj9ERIRGlkSmcnfwHnaSovaCnZSGFOtK6zaCFVc='
					],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self', 'data:'],
					// 'self' covers the same-origin retrieve Worker (/api/retrieve). The one cross-origin
					// egress is browser-direct BYO-key synthesis, path-scoped to api.anthropic.com/v1/messages
					// (no trailing slash) so the browser blocks every other Anthropic path as defense-in-depth
					// behind the structural payload allowlist. Google Calendar hosts (accounts.google.com,
					// oauth2.googleapis.com, www.googleapis.com) join here when OAuth lands - not pre-allowed.
					'connect-src': ['self', 'https://api.anthropic.com/v1/messages'],
					'frame-ancestors': ['none'],
					'base-uri': ['self'],
					'form-action': ['self'],
					'manifest-src': ['self'],
					'worker-src': ['self'],
					// Blocks Flash/legacy plugin injection vectors per OWASP ASVS V14.4.3.
					'object-src': ['none'],

					// Coerces any same-origin http:// reference to https:// before the request
					// fires (OWASP ASVS V14.4.5). SvelteKit accepts boolean for valueless
					// directives like this one.
					'upgrade-insecure-requests': true
				}
			}
		}),
		basicSsl()
	],
	worker: {
		// Drops the ONNX runtime's unused fallback WASM from each worker bundle (~23 MB the embed worker never
		// loads, because it sets `wasmPaths = '/wasm/'`) and fails the build on any other WASM; the reasoning is
		// with the plugin.
		plugins: () => [dropWorkerWasm()]
	},
	test: {
		expect: { requireAssertions: true },
		// Keeps each mock's recorded calls across tests in a file, as the tests were written to expect; the
		// tests that need a fresh mock reset it themselves.
		clearMocks: false,
		passWithNoTests: true,
		projects: [
			{
				extends: true,
				test: {
					name: 'client',
					// Pin the browser-mode server to IPv4 loopback + a FIXED port outside the Windows
					// Hyper-V/WinNAT reserved ranges. The default lands on a reserved high port (63315, inside the
					// 63260-63359 reservation) -> `listen EACCES` -> the run hangs. 31415 is in the registered
					// range, clear of the reservations (which sit up in the 50000s/60000s dynamic range). Two runs at
					// once - separate checkouts - each set VITEST_BROWSER_PORT to a port of their own nearby. Set on
					// this project only, so no other server claims the same port.
					api: { host: '127.0.0.1', port: Number(process.env.VITEST_BROWSER_PORT ?? 31415) },
					browser: {
						enabled: true,
						provider: playwright({ contextOptions: { timezoneId: TEST_TIME_ZONE } }),
						instances: [{ browser: 'chromium', headless: true }],
						// No UI around the test frame, as on CI: locally the UI's pane splitter overlaps the frame's
						// left edge and takes the clicks meant for a control drawn there.
						ui: false,
						// Locators match a name or text as a substring, as the tests were written to expect.
						locators: { exact: false }
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/lib/**/*.browser.test.ts'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: true,
				test: {
					name: 'server',
					environment: 'node',
					// The alias plugin runs before the adapter's resolver, so tests can vi.mock this module.
					alias: {
						'cloudflare:workers': fileURLToPath(
							new URL('./src/lib/ci/cloudflare-workers.stub.ts', import.meta.url)
						)
					},
					env: { TZ: TEST_TIME_ZONE },
					include: [
						'src/**/*.{test,spec}.{js,ts}',
						'eslint-plugins/**/*.{test,spec}.{js,ts}',
						'content-ops/**/*.{test,spec}.{js,ts}',
						'workers/**/*.{test,spec}.{js,ts}'
					],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.browser.test.ts']
				}
			}
		]
	}
});
