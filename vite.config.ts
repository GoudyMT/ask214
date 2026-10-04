import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { dropWorkerWasm } from './src/lib/ci/drop-worker-wasm';

// The app reads today from the device clock, so both test projects run in one fixed zone: every machine and CI
// read the same day, and a zone behind UTC makes a slip back to the UTC date fail here too. A fixed TZ also lets
// a test that stubs another zone get this one back (Node on Windows ignores a deleted TZ).
const TEST_TIME_ZONE = 'America/Los_Angeles';

export default defineConfig({
	// The preview server serves HTTPS off a generated self-signed cert, because the production CSP
	// sends `upgrade-insecure-requests` and browsers that honour it rewrite every asset URL to https.
	// Over plain HTTP that yields a page with no stylesheet at all - which is not a product bug (in
	// production the directive is a no-op, the origin is already HTTPS) but does make the E2E suite
	// unable to test the app as it actually ships. The cert is generated on demand and never written
	// to the repo; a checked-in private key is a liability that protects nothing.
	plugins: [sveltekit(), basicSsl()],
	worker: {
		// Drops the ONNX runtime's unused fallback WASM from each worker bundle (~23 MB the embed worker never
		// loads, because it sets `wasmPaths = '/wasm/'`) and fails the build on any other WASM; the reasoning is
		// with the plugin.
		plugins: () => [dropWorkerWasm()]
	},
	test: {
		expect: { requireAssertions: true },
		passWithNoTests: true,
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright({ contextOptions: { timezoneId: TEST_TIME_ZONE } }),
						instances: [{ browser: 'chromium', headless: true }],
						// Pin the browser-mode server to IPv4 loopback + a FIXED port outside the Windows
						// Hyper-V/WinNAT reserved ranges. The default lands on a reserved high port (63315, inside the
						// 63260-63359 reservation) -> `listen EACCES` -> the run hangs. 31415 is in the registered
						// range, clear of the reservations (which sit up in the 50000s/60000s dynamic range). Two runs at
						// once - separate checkouts - each set VITEST_BROWSER_PORT to a port of their own nearby.
						api: { host: '127.0.0.1', port: Number(process.env.VITEST_BROWSER_PORT ?? 31415) }
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/lib/**/*.browser.test.ts'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
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
