import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

// CI invariant: the public About sources index is GENERATED from content/sources.yaml, so a drift gate
// must run on every PR and push to main to keep the committed artifact in lockstep with the registry
// (the legal record). This test locks that both the generator and the gate scripts exist and that CI
// runs the gate - so the public page can never silently diverge from the sources it claims to list.
// Mirrors the sast-policy / lighthouse-policy tests.
describe('sources-index drift gate policy', () => {
	const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
	const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
	const on = workflow.on;
	const steps = workflow.jobs?.test?.steps ?? [];
	const gateStep = steps.find(
		(s: { run?: string }) => typeof s.run === 'string' && s.run.includes('check:sources-index')
	);

	it('defines the generator and the gate scripts', () => {
		expect(pkg.scripts['build:sources-index']).toContain('content-ops/build-sources-index.mjs');
		expect(pkg.scripts['check:sources-index']).toContain('content-ops/check-sources-index.mjs');
	});

	it('runs the drift gate in CI', () => {
		expect(gateStep).toBeDefined();
	});

	it('runs on every pull request and push to main', () => {
		expect(on?.pull_request?.branches).toContain('main');
		expect(on?.push?.branches).toContain('main');
	});
});
