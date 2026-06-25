import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [sveltekit()],
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
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }],
						// Pin the browser-mode server to IPv4 loopback + a FIXED port outside the Windows
						// Hyper-V/WinNAT reserved ranges. The default lands on a reserved high port (63315, inside the
						// 63260-63359 reservation) -> `listen EACCES` -> the run hangs. 31415 is in the registered
						// range, clear of the reservations (which sit up in the 50000s/60000s dynamic range).
						api: { host: '127.0.0.1', port: 31415 }
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
					include: [
						'src/**/*.{test,spec}.{js,ts}',
						'eslint-plugins/**/*.{test,spec}.{js,ts}',
						'content-ops/**/*.{test,spec}.{js,ts}'
					],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'src/**/*.browser.test.ts']
				}
			}
		]
	}
});
