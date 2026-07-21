import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
	webServer: {
		command: 'pnpm run build && pnpm run preview',
		// HTTPS, matching production. The CSP sends `upgrade-insecure-requests`, so a browser that
		// honours it rewrites every asset URL to https - and over an HTTP preview the stylesheet then
		// 404s and the app renders unstyled. Chromium tolerated that; WebKit did not, which is why the
		// engine closest to Safari could not be tested here at all until this server spoke HTTPS.
		url: 'https://localhost:4173',
		ignoreHTTPSErrors: true,
		reuseExistingServer: !process.env.CI,
		timeout: 120_000
	},
	use: {
		baseURL: 'https://localhost:4173',
		// The preview cert is self-signed and generated per machine: nothing about it is trustworthy
		// and nothing needs to be. Production serves a real one.
		ignoreHTTPSErrors: true,
		// Freeze the home feed's auto-scroll (it honours prefers-reduced-motion) so a moving element
		// cannot flake interactions, and so the reduced-motion path is what CI exercises.
		reducedMotion: 'reduce'
	},
	// WebKit is not Safari, but it is the same engine family - and without an Apple device it is the
	// only way to exercise the Safari-side behaviour this app depends on. It reaches what Chromium
	// structurally cannot show us: no `freeze` event, so visibilitychange is the only relock signal,
	// and a stricter handoff for the blob download that is the calendar export's entire delivery path.
	projects: [
		{
			name: 'chromium',
			use: {
				...devices['Desktop Chrome'],
				// `ignoreHTTPSErrors` lets the navigation through but leaves the page flagged as having a
				// certificate error, and Chromium refuses to register a service worker on such a page -
				// `navigator.serviceWorker.ready` simply never resolves. This flag makes it trust the
				// generated preview cert, restoring the secure context the SW needs. WebKit does not
				// need it. Nothing here reaches production; the flag is scoped to the test browser.
				launchOptions: { args: ['--ignore-certificate-errors'] }
			}
		},
		{ name: 'webkit', use: { ...devices['Desktop Safari'] } }
	],
	testMatch: '**/*.e2e.{ts,js}'
});
