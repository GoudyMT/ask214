import { defineConfig, devices } from '@playwright/test';

// Cross-browser projects added 2026-05-27 per Phase 2 audit T6-B
// (Max lock: "most use iOS but I and many others use Android, so we need full
// access and support for both"). Chromium = Android proxy; WebKit = iOS Safari
// proxy. Real-device smoke checklist (Home Screen install, AES-GCM roundtrip,
// IDB persistence, SW activation, BFCache) added to v1.0 release gate.
// Firefox deferred to v1.1+ smoke (mobile share <=1%).

export default defineConfig({
	webServer: {
		command: 'pnpm run build && pnpm run preview',
		port: 4173,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	},
	use: {
		baseURL: 'http://localhost:4173'
	},
	testMatch: '**/*.e2e.{ts,js}',
	projects: [
		{
			name: 'chromium',
			use: { ...devices['Desktop Chrome'] }
		},
		{
			name: 'webkit',
			use: { ...devices['Desktop Safari'] }
		}
	]
});
