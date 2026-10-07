import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

// The privacy rules are core ESLint rules scoped by file in eslint.config.js, so the risk is the scoping, not the
// rule logic. Each case lints planted code under a real path with the project's own config.
const eslint = new ESLint({ cwd: process.cwd() });

/** The rule ids ESLint reports, after checking the code parsed: a parse failure reports no rule and would pass a
 *  "not flagged" case for the wrong reason. */
async function ruleIds(code, filePath) {
	const [result] = await eslint.lintText(code, { filePath });
	const messages = result?.messages ?? [];
	expect(messages.filter((message) => message.fatal)).toEqual([]);
	return messages.map((message) => message.ruleId);
}

describe('personal data stays out of web storage and cookies', () => {
	it.each([
		['localStorage.setItem("k", "v");', 'no-restricted-globals'],
		['sessionStorage.getItem("k");', 'no-restricted-globals'],
		['cookieStore.set("a", "b");', 'no-restricted-globals'],
		['window.localStorage.clear();', 'no-restricted-properties'],
		['globalThis.sessionStorage.removeItem("k");', 'no-restricted-properties'],
		['self.localStorage.getItem("k");', 'no-restricted-properties'],
		['document.cookie = "a=b";', 'no-restricted-properties'],
		['window.cookieStore.set("a", "b");', 'no-restricted-properties'],
		[
			'export function f(target: Window) { target.localStorage.setItem("k", "v"); }',
			'no-restricted-properties'
		],
		['const w = window; w.localStorage.setItem("k", "v");', 'no-restricted-properties'],
		['window.document.cookie = "a=b";', 'no-restricted-properties'],
		['frames.sessionStorage.setItem("k", "v");', 'no-restricted-properties'],
		['(window as Window).localStorage.setItem("k", "v");', 'no-restricted-properties'],
		['export const { localStorage: ls } = window;', 'no-restricted-properties']
	])('flags %s in app source', async (code, rule) => {
		expect(await ruleIds(code, 'src/lib/planted/storage.ts')).toContain(rule);
	});

	it('flags storage in a Svelte template', async () => {
		const code = '<button onclick={() => localStorage.setItem("k", "v")}>Remember</button>\n';
		expect(await ruleIds(code, 'src/lib/components/EaosInput.svelte')).toContain(
			'no-restricted-globals'
		);
	});

	it.each([
		'src/lib/theme/theme.ts',
		'src/lib/install/dismissed.ts',
		'src/lib/ask/online-prefs.ts',
		'src/lib/feedback/context.ts'
	])('allows %s, a device setting with nothing personal', async (filePath) => {
		expect(await ruleIds('localStorage.setItem("k", "v");', filePath)).not.toContain(
			'no-restricted-globals'
		);
	});

	it('leaves tests free to stage storage', async () => {
		expect(
			await ruleIds('localStorage.setItem("k", "v");', 'src/lib/planted/storage.test.ts')
		).not.toContain('no-restricted-globals');
	});
});

describe('the safelog test accessor stays out of app code', () => {
	it.each([
		["import { getDiagnosticsForTest } from '$lib/log/safelog';", 'no-restricted-imports'],
		["import { getDiagnosticsForTest } from '../log/safelog';", 'no-restricted-imports'],
		[
			"import { safeLog, getDiagnosticsForTest } from '../../lib/log/safelog';",
			'no-restricted-imports'
		],
		["import { getDiagnosticsForTest } from './safelog';", 'no-restricted-imports'],
		["import { getDiagnosticsForTest } from '$lib/log/safelog.js';", 'no-restricted-imports'],
		["import { getDiagnosticsForTest } from './safelog.ts';", 'no-restricted-imports'],
		["export const m = await import('$lib/log/safelog');", 'no-restricted-syntax'],
		["export const m = await import('./safelog.js');", 'no-restricted-syntax']
	])('flags %s in app source', async (code, rule) => {
		expect(await ruleIds(code, 'src/lib/log/planted.ts')).toContain(rule);
	});

	it('allows the sink itself', async () => {
		expect(
			await ruleIds("import { safeLog } from '$lib/log/safelog';", 'src/lib/log/planted.ts')
		).not.toContain('no-restricted-imports');
	});

	it('allows tests to read the buffer', async () => {
		const ids = await ruleIds(
			"import { getDiagnosticsForTest } from '$lib/log/safelog';",
			'src/lib/log/planted.test.ts'
		);
		expect(ids).not.toContain('no-restricted-imports');
		expect(ids).not.toContain('no-restricted-syntax');
	});
});
