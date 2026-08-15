import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// CI invariant: the CodeQL workflow is the launch-gate static-analysis scanner. This test locks its
// load-bearing config so it cannot silently regress into a no-op - the scan must run on every PR and
// push to main (plus a weekly re-scan so newly-published queries reach unchanged code), analyze the
// JavaScript/TypeScript that holds our security-critical logic, and use the higher-recall
// security-extended suite. Merge-blocking on findings is enforced separately by branch protection
// (required status check + code scanning), its own launch-gate item; this test locks the SCAN, not
// the block. Mirrors the lighthouse-policy / headers-policy CI-invariant tests.

describe('CodeQL SAST workflow policy', () => {
	const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/codeql.yml'), 'utf8'));
	const on = workflow.on;
	const analyze = workflow.jobs?.analyze;
	const initStep = analyze?.steps?.find(
		(s: { uses?: string }) =>
			typeof s.uses === 'string' && s.uses.startsWith('github/codeql-action/init')
	);

	it('scans on every pull request and push to main', () => {
		expect(on?.pull_request?.branches).toContain('main');
		expect(on?.push?.branches).toContain('main');
	});

	it('re-scans on a schedule so newly-published queries reach unchanged code', () => {
		expect(Array.isArray(on?.schedule)).toBe(true);
		expect(on.schedule.length).toBeGreaterThan(0);
		expect(typeof on.schedule[0].cron).toBe('string');
	});

	it('grants only the scoped permission CodeQL needs to upload findings, not a repo-wide token', () => {
		expect(analyze?.permissions?.['security-events']).toBe('write');
	});

	it('analyzes JavaScript/TypeScript with the security-extended query suite', () => {
		expect(initStep).toBeDefined();
		expect(initStep?.with?.languages).toBe('javascript-typescript');
		expect(initStep?.with?.queries).toBe('security-extended');
	});
});
