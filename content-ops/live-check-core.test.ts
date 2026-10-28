import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ACCEPTED_CORPUS_VERSION } from '../src/lib/corpus/codec';
import {
	deployLanded,
	judgeAnswer,
	readAcceptedVersion,
	worthRetrying
} from './live-check-core.mjs';

// The live check stands in for a person after every merge: the app deploys itself, but the retrieve Worker and its
// index deploy by hand, so a merge that moves the app's expected answer library breaks every online answer with
// nothing red anywhere. Each failure kind below is one way that outage, or a failed deploy, shows on the live site.

describe('deployLanded', () => {
	const MERGED_AT_MS = 1_793_123_825_000;

	it('waits while the live build is older than the merge', () => {
		expect(deployLanded('{"version":"1793123800000"}', MERGED_AT_MS)).toBe(false);
	});

	it('reports the deploy landed once the live build is from after the merge', () => {
		expect(deployLanded('{"version":"1793123860566"}', MERGED_AT_MS)).toBe(true);
	});

	// A page that is not the build stamp (an error page, a changed format) must not read as "landed".
	it('refuses a version file it cannot read', () => {
		expect(() => deployLanded('<html>502</html>', MERGED_AT_MS)).toThrow('E_LIVE_BAD_VERSION');
		expect(() => deployLanded('{"version":"v1.10.0"}', MERGED_AT_MS)).toThrow('E_LIVE_BAD_VERSION');
	});
});

describe('judgeAnswer', () => {
	const ACCEPTED = '1.0.2';

	it('passes a 200 with results from the library the app expects', () => {
		expect(() =>
			judgeAnswer(
				{ httpStatus: 200, body: { status: 'results', corpusVersion: '1.0.2' } },
				ACCEPTED
			)
		).not.toThrow();
	});

	// The outage this guards: the app moved to a new library while the Worker still served the old one.
	it('fails when the live library differs from the one the app expects', () => {
		expect(() =>
			judgeAnswer(
				{ httpStatus: 200, body: { status: 'results', corpusVersion: '1.0.1' } },
				ACCEPTED
			)
		).toThrow('E_LIVE_VERSION_MISMATCH');
	});

	it('fails when the server does not answer 200', () => {
		expect(() => judgeAnswer({ httpStatus: 403, body: null }, ACCEPTED)).toThrow('E_LIVE_HTTP');
	});

	// The question is one the library answers; no results, a refusal for load or an error all mean members
	// asking online get nothing.
	it.each(['empty', 'high_demand', 'error'])('fails on a "%s" answer', (status) => {
		expect(() =>
			judgeAnswer({ httpStatus: 200, body: { status, corpusVersion: '1.0.2' } }, ACCEPTED)
		).toThrow('E_LIVE_NO_RESULTS');
	});
});

// The check runs with no one watching, so one network blip must not raise a false alarm; a wrong library is a
// real outage and fails at once.
describe('worthRetrying', () => {
	it('retries a failure that a blip or a busy moment can cause', () => {
		for (const code of ['E_LIVE_NETWORK', 'E_LIVE_HTTP', 'E_LIVE_NO_RESULTS']) {
			expect(worthRetrying(code), code).toBe(true);
		}
	});

	it('never retries a library mismatch', () => {
		expect(worthRetrying('E_LIVE_VERSION_MISMATCH')).toBe(false);
	});
});

describe('readAcceptedVersion', () => {
	it('reads the version the app accepts from its codec source', () => {
		expect(readAcceptedVersion("export const ACCEPTED_CORPUS_VERSION = '1.0.2';\n")).toBe('1.0.2');
	});

	// The runner reads the real file as text; a reshaped declaration there must fail here, not after a merge.
	it('reads the real codec source the runner reads', () => {
		expect(readAcceptedVersion(readFileSync('src/lib/corpus/codec.ts', 'utf8'))).toBe(
			ACCEPTED_CORPUS_VERSION
		);
	});

	// A renamed or reshaped constant must stop the check, never let it compare against nothing.
	it('refuses a source without the constant', () => {
		expect(() => readAcceptedVersion('export const OTHER = 1;')).toThrow(
			'E_LIVE_NO_ACCEPTED_VERSION'
		);
	});
});
