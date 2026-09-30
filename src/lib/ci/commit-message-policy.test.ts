import { describe, it, expect } from 'vitest';
import { findCommitMessageViolations } from './commit-message-policy';

const SCISSORS = '# ------------------------ >8 ------------------------';

// What git writes into the message file when it opens an editor (here after `git commit -v`).
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
		expect(findCommitMessageViolations(EDITOR_TEMPLATE, { editorOpened: true })).toEqual([]);
	});

	it('reads the same template as a message with a body when no editor opened', () => {
		const violations = findCommitMessageViolations(EDITOR_TEMPLATE, { editorOpened: false });
		expect(violations).toContain('The message must be one line, with no body and no trailer.');
	});

	it('treats a message as written with no editor when the caller does not say', () => {
		expect(findCommitMessageViolations(EDITOR_TEMPLATE)).toEqual(
			findCommitMessageViolations(EDITOR_TEMPLATE, { editorOpened: false })
		);
		expect(findCommitMessageViolations(EDITOR_TEMPLATE)).not.toEqual([]);
		expect(findCommitMessageViolations('fix: x\n\n#42\n', {})).toHaveLength(1);
	});

	it('rejects a # line as a body when no editor opened', () => {
		const violations = findCommitMessageViolations('fix: x\n\n#42\n', { editorOpened: false });
		expect(violations).toEqual(['The message must be one line, with no body and no trailer.']);
	});

	it('accepts a # line after the message when an editor opened, because git removes it', () => {
		expect(findCommitMessageViolations('fix: x\n\n#42\n', { editorOpened: true })).toEqual([]);
	});

	it('rejects text under a scissors line when no editor opened', () => {
		const violations = findCommitMessageViolations(`fix: x\n${SCISSORS}\nmore text\n`, {
			editorOpened: false
		});
		expect(violations).toEqual(['The message must be one line, with no body and no trailer.']);
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

	it('rejects a message of only comment lines once the editor has them removed', () => {
		const violations = findCommitMessageViolations(
			'# Please enter the commit message\n#\n# On branch main\n',
			{ editorOpened: true }
		);
		expect(violations).toEqual(['The message is empty.']);
	});

	it('rejects a message whose only text is below the scissors line once the editor has it removed', () => {
		expect(
			findCommitMessageViolations(`${SCISSORS}\nfix: add x\n`, { editorOpened: true })
		).toEqual(['The message is empty.']);
	});

	it('rejects a message of only comment lines as not in the format when no editor opened', () => {
		const violations = findCommitMessageViolations('# Please enter the commit message\n', {
			editorOpened: false
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
		for (const raw of [`${secret}: x`, `fix: ${secret}.`, `fix: a\n${secret}`]) {
			const violations = findCommitMessageViolations(raw);
			expect(violations.length).toBeGreaterThan(0);
			for (const violation of violations) {
				expect(violation).not.toContain(secret);
			}
		}
	});
});
