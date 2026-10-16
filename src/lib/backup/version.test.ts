import { describe, expect, it } from 'vitest';
import { compareVersions, isAppVersion } from './version';

describe('compareVersions', () => {
	// A file's appVersion decides between "update the app" and "part of it cannot be read", so a text compare
	// ('1.9.0' > '1.10.0') would tell a person on 1.9.0 their own newer file is damaged.
	it.each([
		['1.10.0', '1.9.0', 1],
		['1.7.2', '1.7.2', 0],
		['2.0.0', '1.99.99', 1],
		['1.7.2', '1.7.10', -1],
		['0.0.1', '0.0.0', 1],
		['10.0.0', '9.9.9', 1]
	] as const)('%s against %s is %i', (a, b, expected) => {
		expect(compareVersions(a, b)).toBe(expected);
		expect(compareVersions(b, a)).toBe(expected === 0 ? 0 : -expected);
	});
});

describe('isAppVersion', () => {
	it.each(['1.7.2', '0.0.0', '10.20.30', '123456.0.99999', '999999.999999.999999'])(
		'accepts %s',
		(v) => {
			expect(isAppVersion(v)).toBe(true);
		}
	);

	// The file's appVersion is shown to the person and compared with the app's, so it is held to the one shape
	// package.json writes; nothing else can reach a screen.
	it.each([
		['two parts', '1.2'],
		['a leading zero', '01.2.3'],
		['four parts', '1.2.3.4'],
		['a pre-release tag', '1.2.3-beta'],
		['a v prefix', 'v1.2.3'],
		['empty', ''],
		['a leading space', ' 1.2.3'],
		['a trailing newline', '1.2.3\n'],
		['a seven-digit part', '1.2.1234567'],
		['an empty part', '1..3'],
		['a negative part', '1.2.-3'],
		['21 characters', '123456.123456.1234567'],
		['Arabic-Indic digits', String.fromCharCode(0x661) + '.2.3'],
		['an array', ['1.2.3']]
	] as const)('refuses %s', (_name, v) => {
		expect(isAppVersion(v)).toBe(false);
	});
});
