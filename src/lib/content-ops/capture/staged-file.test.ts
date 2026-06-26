import { describe, test, expect } from 'vitest';
import { stagedFileName } from './staged-file';

describe('stagedFileName', () => {
	test('extracts the PDF filename after the "File:" marker', () => {
		expect(stagedFileName('Public TAP doc. File: TAP_Guide_v6.pdf (vetted)')).toBe(
			'TAP_Guide_v6.pdf'
		);
	});

	test('is case-insensitive on the marker', () => {
		expect(stagedFileName('file: x.pdf')).toBe('x.pdf');
	});

	test('returns null when there is no marker / empty / nullish input', () => {
		expect(stagedFileName('no marker here')).toBe(null);
		expect(stagedFileName('')).toBe(null);
		expect(stagedFileName(undefined)).toBe(null);
		expect(stagedFileName(null)).toBe(null);
	});

	test('stops at the first whitespace (does not grab trailing words)', () => {
		expect(stagedFileName('File: a.pdf and more notes')).toBe('a.pdf');
	});

	test('matches only the first File: token', () => {
		expect(stagedFileName('File: first.pdf ... also File: second.pdf')).toBe('first.pdf');
	});

	test('requires the .pdf extension', () => {
		expect(stagedFileName('File: notapdf.txt')).toBe(null);
	});
});
