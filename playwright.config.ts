import { defineConfig } from '@playwright/test';

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
	testMatch: '**/*.e2e.{ts,js}'
});
