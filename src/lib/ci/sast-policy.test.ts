import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// CI invariant: the Semgrep workflow is the launch-gate static-analysis scanner. This test locks its
// load-bearing config so it cannot silently regress into a no-op - the scan must run on every PR and
// push to main (plus a weekly re-scan so newly-published rules reach unchanged code), pull rules from
// a ruleset, keep telemetry off (--metrics=off) so no scan data leaves the machine, and block the
// build on findings (--error). Two reviewed policy rules are excluded (see the workflow comment).
// Mirrors the lighthouse-policy / headers-policy tests.

describe('Semgrep SAST workflow policy', () => {
	const workflow = parse(
		readFileSync(join(process.cwd(), '.github/workflows/semgrep.yml'), 'utf8')
	);
	const on = workflow.on;
	const scanJob = workflow.jobs?.scan;
	const scanStep = scanJob?.steps?.find(
		(s: { run?: string }) => typeof s.run === 'string' && s.run.includes('semgrep scan')
	);

	it('scans on every pull request and push to main', () => {
		expect(on?.pull_request?.branches).toContain('main');
		expect(on?.push?.branches).toContain('main');
	});

	it('re-scans on a schedule so newly-published rules reach unchanged code', () => {
		expect(Array.isArray(on?.schedule)).toBe(true);
		expect(on.schedule.length).toBeGreaterThan(0);
		expect(typeof on.schedule[0].cron).toBe('string');
	});

	it('grants only read access - findings stay in the log, nothing is uploaded', () => {
		expect(scanJob?.permissions?.contents).toBe('read');
	});

	it('runs semgrep against a ruleset with telemetry disabled', () => {
		expect(scanStep).toBeDefined();
		expect(scanStep?.run).toContain('--config');
		expect(scanStep?.run).toContain('--metrics=off');
	});

	it('blocks the build on findings (--error)', () => {
		expect(scanStep?.run).toContain('--error');
	});
});
