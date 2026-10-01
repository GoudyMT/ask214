import { describe, it, expect } from 'vitest';
import { findCommitMessageViolations } from './commit-message-policy';

const SCISSORS = '# ------------------------ >8 ------------------------';
const CONTROL_SENTENCE =
	'The message holds a control character, such as a tab or a lone carriage return; use plain text.';
const BOM_SENTENCE = 'The message starts with a byte-order mark; save it as UTF-8 without one.';

// What git writes into the message file the hook reads when it opens an editor (here after `git commit -v`).
const EDITOR_TEMPLATE = [
	'fix: hold the page still',
	'',
	'# Please enter the commit message for your changes.',
	'#',
	'# On branch main',
	SCISSORS,
	'# Do not modify or remove the line above.',
	'diff --git a/x b/x',
	'+Co-Authored-By: someone in the diff, not in the message',
	'Not a comment line inside the diff',
	''
].join('\n');

describe('findCommitMessageViolations', () => {
	it('accepts a one-line message with a type and a lowercase subject', () => {
		expect(
			findCommitMessageViolations('fix: hold the page still behind the open reader\n')
		).toEqual([]);
	});

	it('accepts a scoped type', () => {
		expect(
			findCommitMessageViolations('chore(deps-dev): bump undici from 7.1.0 to 7.2.0\n')
		).toEqual([]);
	});

	it('accepts every type the format names', () => {
		for (const type of ['feat', 'fix', 'refactor', 'test', 'docs', 'chore', 'security', 'perf']) {
			expect(findCommitMessageViolations(`${type}: do the thing`)).toEqual([]);
		}
	});

	it('accepts the editor template: a valid line, comment lines, and a scissors section holding a diff', () => {
		expect(findCommitMessageViolations(EDITOR_TEMPLATE, { stripComments: true })).toEqual([]);
	});

	it('reads the same template as a message with a body when comments are not stripped', () => {
		const violations = findCommitMessageViolations(EDITOR_TEMPLATE, { stripComments: false });
		expect(violations).toContain('The message must be one line, with no body and no trailer.');
	});

	it('reads a message as recorded, comment lines included, when the caller does not say', () => {
		expect(findCommitMessageViolations(EDITOR_TEMPLATE)).toEqual(
			findCommitMessageViolations(EDITOR_TEMPLATE, { stripComments: false })
		);
		expect(findCommitMessageViolations(EDITOR_TEMPLATE)).not.toEqual([]);
		expect(findCommitMessageViolations('fix: x\n\n#42\n', {})).toHaveLength(1);
	});

	it('rejects a # line as a body when comments are not stripped', () => {
		const violations = findCommitMessageViolations('fix: x\n\n#42\n', { stripComments: false });
		expect(violations).toEqual(['The message must be one line, with no body and no trailer.']);
	});

	it('accepts a # line after the message when comments are stripped', () => {
		expect(findCommitMessageViolations('fix: x\n\n#42\n', { stripComments: true })).toEqual([]);
	});

	it('rejects text under a scissors line when comments are not stripped', () => {
		const violations = findCommitMessageViolations(`fix: x\n${SCISSORS}\nmore text\n`, {
			stripComments: false
		});
		expect(violations).toEqual(['The message must be one line, with no body and no trailer.']);
	});

	it('drops the scissors line and all below it when comments are stripped', () => {
		expect(
			findCommitMessageViolations(`fix: x\n${SCISSORS}\nmore text\n`, { stripComments: true })
		).toEqual([]);
	});

	it('accepts the block git adds to the message of a conflicted cherry-pick when comments are stripped', () => {
		const raw = 'fix: edit same on src\n\n# Conflicts:\n#\tsrc/a.ts\n';
		expect(findCommitMessageViolations(raw, { stripComments: true })).toEqual([]);
		expect(findCommitMessageViolations(raw)).not.toEqual([]);
	});

	it('rejects a lone carriage return inside the subject line', () => {
		const violations = findCommitMessageViolations('fix: add b\rCo-Authored-By: Someone <x@y.z>');
		expect(violations).toEqual([CONTROL_SENTENCE]);
	});

	it('rejects a lone carriage return on a line of its own', () => {
		expect(findCommitMessageViolations('fix: add b\r\r\n')).toEqual([CONTROL_SENTENCE]);
	});

	it('accepts a one-line message that ends with a CRLF line break', () => {
		expect(findCommitMessageViolations('fix: add b\r\n')).toEqual([]);
	});

	it('lets go of any run of trailing spaces, tabs and carriage returns when comments are stripped, as git does', () => {
		for (const raw of ['fix: x\r\r\n', 'fix: x\r \n', 'fix: x \t\r\r\n', 'fix: x\r\n\r\r\n']) {
			expect(
				findCommitMessageViolations(raw, { stripComments: true }),
				JSON.stringify(raw)
			).toEqual([]);
		}
	});

	it('still refuses a carriage return in the middle of a line when comments are stripped', () => {
		expect(findCommitMessageViolations('fix: a\rb\r\r\n', { stripComments: true })).toEqual([
			CONTROL_SENTENCE
		]);
		expect(findCommitMessageViolations('fix: a\r\nb\rc', { stripComments: true })).toContain(
			CONTROL_SENTENCE
		);
	});

	it('keeps the strict reading of trailing carriage returns for a recorded message', () => {
		expect(findCommitMessageViolations('fix: x\r\r\n', { stripComments: false })).toEqual([
			CONTROL_SENTENCE
		]);
		expect(findCommitMessageViolations('fix: x\r \n', { stripComments: false })).toEqual([
			CONTROL_SENTENCE
		]);
	});

	it('rejects characters that break or hide a line without being control characters', () => {
		// U+2028 and U+2029 end a line for some readers, U+202E reverses text, and U+FEFF is invisible mid-message.
		for (const code of [0x2028, 0x2029, 0x202e, 0xfeff, 0x200b, 0x2066]) {
			const raw = `fix: add ${String.fromCharCode(code)}b`;
			for (const stripComments of [false, true]) {
				expect(
					findCommitMessageViolations(raw, { stripComments }),
					`code ${code} strip ${stripComments}`
				).toEqual([CONTROL_SENTENCE]);
			}
		}
	});

	it('rejects such a character at the end of the line, where trimming must not hide it', () => {
		const raw = `fix: add b${String.fromCharCode(0x2028)}`;
		expect(findCommitMessageViolations(raw)).toEqual([CONTROL_SENTENCE]);
		expect(findCommitMessageViolations(raw, { stripComments: true })).toEqual([CONTROL_SENTENCE]);
	});

	it('gives a leading byte-order mark only its own sentence, not the control sentence as well', () => {
		const bom = String.fromCharCode(0xfeff);
		expect(findCommitMessageViolations(`${bom}fix: add x`)).toEqual([BOM_SENTENCE]);
		expect(findCommitMessageViolations(`${bom}fix: add${bom}x`)).toEqual([
			BOM_SENTENCE,
			CONTROL_SENTENCE
		]);
	});

	it('rejects a tab inside the line', () => {
		expect(findCommitMessageViolations('fix: add\tb')).toEqual([CONTROL_SENTENCE]);
	});

	it('rejects another control character: an escape, a null and a delete', () => {
		for (const code of [0x1b, 0x00, 0x7f, 0x85]) {
			const raw = `fix: add ${String.fromCharCode(code)}b`;
			expect(findCommitMessageViolations(raw), `code ${code}`).toEqual([CONTROL_SENTENCE]);
		}
	});

	it('does not count a tab in a comment line that is stripped', () => {
		expect(
			findCommitMessageViolations('fix: x\n#\tmodified: a\n', { stripComments: true })
		).toEqual([]);
	});

	it('gives a byte-order mark its own sentence and judges the rest of the message', () => {
		const bom = String.fromCharCode(0xfeff);
		expect(findCommitMessageViolations(`${bom}fix: add x\r\n`)).toEqual([BOM_SENTENCE]);
		expect(findCommitMessageViolations(`${bom}fix: Add x`)).toEqual([
			BOM_SENTENCE,
			'The subject must start with a lowercase letter.'
		]);
		expect(findCommitMessageViolations(bom)).toEqual([BOM_SENTENCE, 'The message is empty.']);
	});

	it('accepts a message with a CRLF line ending and trailing whitespace', () => {
		expect(findCommitMessageViolations('fix: hold the page still  \r\n\r\n')).toEqual([]);
	});

	it('rejects a body after a blank line', () => {
		const violations = findCommitMessageViolations(
			'fix: hold the page still\n\nmore detail here\n'
		);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/one line/);
	});

	it('rejects a body on the next line with no blank line between', () => {
		expect(findCommitMessageViolations('fix: hold the page still\nmore detail').length).toBe(1);
	});

	it('rejects a Co-Authored-By trailer', () => {
		const violations = findCommitMessageViolations(
			'fix: hold the page still\n\nCo-Authored-By: Someone <x@y.z>\n'
		);
		expect(violations.length).toBeGreaterThan(0);
	});

	it('rejects a trailer given with no subject-format problem on the first line', () => {
		expect(
			findCommitMessageViolations('fix: hold the page still\nCo-Authored-By: Someone <x@y.z>')
		).toEqual(['The message must be one line, with no body and no trailer.']);
	});

	it('rejects an unknown type', () => {
		const violations = findCommitMessageViolations('feature: add x');
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/type: subject/);
	});

	it('rejects an uppercase type', () => {
		expect(findCommitMessageViolations('Fix: add x')).toHaveLength(1);
	});

	it('rejects an uppercase scope', () => {
		expect(findCommitMessageViolations('fix(Ui): add x')).toHaveLength(1);
	});

	it('rejects a missing space after the colon', () => {
		expect(findCommitMessageViolations('fix:add x')).toHaveLength(1);
	});

	it('rejects two spaces after the colon', () => {
		expect(findCommitMessageViolations('fix:  add x')).toHaveLength(1);
	});

	it('rejects a subject that starts with an uppercase letter', () => {
		expect(findCommitMessageViolations('fix: Add x')).toEqual([
			'The subject must start with a lowercase letter.'
		]);
	});

	it('rejects a subject that ends with a period', () => {
		expect(findCommitMessageViolations('fix: add x.')).toEqual([
			'The subject must not end with a period.'
		]);
	});

	it('rejects a fixup commit', () => {
		expect(findCommitMessageViolations('fixup! fix: add x')).toHaveLength(1);
	});

	it('rejects an empty message', () => {
		const violations = findCommitMessageViolations('');
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/empty/);
	});

	it('rejects a message of only whitespace as empty', () => {
		expect(findCommitMessageViolations('  \n\n\t\n')).toEqual(['The message is empty.']);
	});

	it('reads a period before trailing whitespace as the end of the subject', () => {
		expect(findCommitMessageViolations('fix: add x.  \n')).toEqual([
			'The subject must not end with a period.'
		]);
	});

	it('rejects a message of only comment lines once they are stripped', () => {
		const violations = findCommitMessageViolations(
			'# Please enter the commit message\n#\n# On branch main\n',
			{ stripComments: true }
		);
		expect(violations).toEqual(['The message is empty.']);
	});

	it('rejects a message whose only text is below the scissors line once it is stripped', () => {
		expect(
			findCommitMessageViolations(`${SCISSORS}\nfix: add x\n`, { stripComments: true })
		).toEqual(['The message is empty.']);
	});

	it('rejects a message of only comment lines as not in the format when comments are not stripped', () => {
		const violations = findCommitMessageViolations('# Please enter the commit message\n', {
			stripComments: false
		});
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/type: subject/);
	});

	it('names each problem once when a line is wrong in two ways', () => {
		expect(findCommitMessageViolations('fix: Add x.')).toEqual([
			'The subject must start with a lowercase letter.',
			'The subject must not end with a period.'
		]);
	});

	it('judges the subject only once the line has the right shape', () => {
		const violations = findCommitMessageViolations('feature: Add x.');
		expect(violations).toHaveLength(1);
		expect(violations[0]).toMatch(/type: subject/);
	});

	it('gives messages that never repeat the input', () => {
		const secret = 'SECRET-TOKEN-123';
		const bom = String.fromCharCode(0xfeff);
		for (const raw of [
			`${secret}: x`,
			`fix: ${secret}.`,
			`fix: a\n${secret}`,
			`fix: a\r${secret}`,
			`${bom}fix: a\t${secret}`
		]) {
			const violations = findCommitMessageViolations(raw);
			expect(violations.length).toBeGreaterThan(0);
			for (const violation of violations) {
				expect(violation).not.toContain(secret);
			}
		}
	});
});
