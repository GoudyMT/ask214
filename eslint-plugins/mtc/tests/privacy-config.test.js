import { ESLint } from 'eslint';
import { describe, it, expect } from 'vitest';

// The privacy rules are core ESLint rules scoped by file in eslint.config.js, so the risk is the scoping, not the
// rule logic. Each case lints planted code under a real path with the project's own config.
const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(code, filePath) {
	const [result] = await eslint.lintText(code, { filePath });
	return (result?.messages ?? []).map((message) => message.ruleId);
}

describe('personal data stays out of web storage and cookies', () => {
	it.each([
		['localStorage.setItem("k", "v");', 'no-restricted-globals'],
		['sessionStorage.getItem("k");', 'no-restricted-globals'],
		['window.localStorage.clear();', 'no-restricted-properties'],
		['globalThis.sessionStorage.removeItem("k");', 'no-restricted-properties'],
		['self.localStorage.getItem("k");', 'no-restricted-properties'],
		['document.cookie = "a=b";', 'no-restricted-properties']
	])('flags %s in app source', async (code, rule) => {
		expect(await ruleIds(code, 'src/lib/planted/storage.ts')).toContain(rule);
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
