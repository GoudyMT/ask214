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

const STORAGE_MESSAGE =
	'Personal data persists only in the encrypted IndexedDB stores. A device setting with nothing personal belongs in an exempt file, or in a disable with its reason.';
const CACHE_MESSAGE =
	'Personal data must not reach unencrypted storage, and the Cache API and the origin-private file system are unencrypted. Public documents are cached only in src/lib/sources/document-cache.ts and src/service-worker.ts; anything else needs a disable with its reason.';
const SAFELOG_MESSAGE = 'getDiagnosticsForTest is for tests only; app code logs through safeLog.';

// The two restriction lists below are built from these pieces because a later config block replaces a rule's options
// rather than merging them: each file group needs its own full list.
const STORAGE_GLOBALS = [
	{ name: 'localStorage', message: STORAGE_MESSAGE },
	{ name: 'sessionStorage', message: STORAGE_MESSAGE },
	{ name: 'cookieStore', message: STORAGE_MESSAGE }
];
// By property name alone, whatever the object: a rule keyed to `window` misses a Window passed in as a
// parameter, an alias, `frames` or `window.document`.
const STORAGE_PROPERTIES = [
	{ property: 'localStorage', message: STORAGE_MESSAGE },
	{ property: 'sessionStorage', message: STORAGE_MESSAGE },
	{ property: 'cookie', message: STORAGE_MESSAGE },
	{ property: 'cookieStore', message: STORAGE_MESSAGE }
];
const CACHE_GLOBALS = [{ name: 'caches', message: CACHE_MESSAGE }];
const CACHE_PROPERTIES = [
	{ property: 'caches', message: CACHE_MESSAGE },
	{ property: 'getDirectory', message: CACHE_MESSAGE }
];

const TEST_FILES = [
	'src/**/*.test.ts',
	'src/**/*.test.js',
	'src/**/*.browser.test.ts',
	'src/**/*.svelte.test.ts'
];
// Device settings with nothing personal, free to use web storage.
const STORAGE_EXEMPT = [
	'src/lib/theme/theme.ts',
	'src/lib/install/dismissed.ts',
	'src/lib/ask/online-prefs.ts',
	'src/lib/feedback/context.ts'
];
// Public documents only, free to use the Cache API and the origin-private file system.
const CACHE_EXEMPT = ['src/lib/sources/document-cache.ts', 'src/service-worker.ts'];

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
		files: ['src/**/*.{ts,js,svelte}'],
		ignores: [
			'src/**/*.test.ts',
			'src/**/*.test.js',
			'src/**/*.browser.test.ts',
			'src/**/*.svelte.test.ts'
		],
		rules: {
			'no-console': 'error',
			// The diagnostics buffer's accessor is for tests; app code reading the live buffer would build the public
			// diagnostics API the sink exists to avoid.
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['**/log/safelog', '**/log/safelog.*', './safelog', './safelog.*'],
							importNames: ['getDiagnosticsForTest'],
							message: SAFELOG_MESSAGE
						}
					]
				}
			],
			// The import rule does not see import(), so app code imports the sink statically or not at all.
			'no-restricted-syntax': [
				'error',
				{
					selector: 'ImportExpression[source.value=/safelog(\\.[jt]s)?$/]',
					message: SAFELOG_MESSAGE
				},
				{
					selector:
						"ImportExpression[source.type='TemplateLiteral'] TemplateElement[value.raw=/safelog(\\.[jt]s)?$/]",
					message: SAFELOG_MESSAGE
				}
			]
		}
	},
	{
		// Personal data persists only through the encrypted IndexedDB stores, so web storage, cookies, the Cache API and
		// the origin-private file system are banned in app source. The storage-exempt files hold device settings with
		// nothing personal (theme, the install nudge, online preferences, the feedback page's return route); the
		// cache-exempt files hold public documents only. The few other lines that need one carry their own disable
		// with the reason.
		files: ['src/**/*.{ts,js,svelte}'],
		ignores: [...TEST_FILES, ...STORAGE_EXEMPT, ...CACHE_EXEMPT],
		rules: {
			'no-restricted-globals': ['error', ...STORAGE_GLOBALS, ...CACHE_GLOBALS],
			'no-restricted-properties': ['error', ...STORAGE_PROPERTIES, ...CACHE_PROPERTIES]
		}
	},
	{
		// An exemption from one ban is not an exemption from the other, so each exempt group keeps the other's list.
		files: STORAGE_EXEMPT,
		rules: {
			'no-restricted-globals': ['error', ...CACHE_GLOBALS],
			'no-restricted-properties': ['error', ...CACHE_PROPERTIES]
		}
	},
	{
		files: CACHE_EXEMPT,
		rules: {
			'no-restricted-globals': ['error', ...STORAGE_GLOBALS],
			'no-restricted-properties': ['error', ...STORAGE_PROPERTIES]
		}
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
