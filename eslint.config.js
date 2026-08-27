import prettier from 'eslint-config-prettier';
import path from 'node:path';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';
import mtc from './eslint-plugins/mtc/index.js';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	// Vendored, committed assets (self-hosted model + ORT wasm glue + corpus) are not source - do not
	// lint them. Mirrors .prettierignore's /static/; without this, eslint flags the minified ORT .mjs.
	{ ignores: ['static/**'] },
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		// An eslint-disable that stops matching anything is a signal, not litter: it means the rule it
		// names went blind to that call site, so a guarded line is now unguarded. The default `warn`
		// hides that, and lint-staged's --fix deletes the directive outright - which is how a
		// sanctioned encryption-boundary write silently lost its guard. Error, so it fails the commit
		// instead. Paired with --fix-type in lint-staged, which withholds the directive autofix so
		// there is still something left to report.
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		// The app runtime routes all diagnostics through the type-safe safeLog sink
		// (src/lib/log/safelog.ts): a raw console.* could leak decrypted PII (e.g. console.error(err)
		// where err wraps profile data), so console is banned in runtime source. Build-time CLI
		// scripts (content-ops) and tests keep console.
		files: ['src/**/*.{ts,svelte}'],
		ignores: ['src/**/*.test.ts', 'src/**/*.browser.test.ts', 'src/**/*.svelte.test.ts'],
		rules: { 'no-console': 'error' }
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser,
				svelteConfig
			}
		}
	},
	{
		plugins: { mtc },
		// Override or add rule settings here, such as:
		// 'svelte/button-has-type': 'error'
		// mtc rule entries are enabled as each rule is implemented.
		rules: {
			'mtc/safelog-no-error': 'error',
			'mtc/encrypted-store-registry': 'error',
			'mtc/no-input-in-error': 'error'
		}
	},
	{
		// Tests stage encrypted-store fixtures directly; the boundary rule guards
		// production writes only.
		files: ['**/*.test.ts', '**/*.browser.test.ts'],
		rules: { 'mtc/encrypted-store-registry': 'off' }
	}
);
