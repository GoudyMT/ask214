import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { findPermissionViolations } from './ci-permissions-policy';

describe('findPermissionViolations', () => {
	it('flags a job with no permissions block', () => {
		const v = findPermissionViolations({ jobs: { build: {} } });
		expect(v.some((m) => m.includes('build') && m.includes('no permissions'))).toBe(true);
	});

	it('flags a job granting a write scope', () => {
		const v = findPermissionViolations({ jobs: { build: { permissions: { contents: 'write' } } } });
		expect(v.some((m) => m.includes('contents: write'))).toBe(true);
	});

	it('flags the write-all shorthand', () => {
		const v = findPermissionViolations({ jobs: { build: { permissions: 'write-all' } } });
		expect(v.some((m) => m.includes('write-all'))).toBe(true);
	});

	it('passes a read-only job', () => {
		const v = findPermissionViolations({ jobs: { build: { permissions: { contents: 'read' } } } });
		expect(v).toEqual([]);
	});
});

describe('the committed CI workflow is least-privilege', () => {
	it('every job in ci.yml declares a read-only permissions block', () => {
		const workflow = parse(
			readFileSync(join(process.cwd(), '.github', 'workflows', 'ci.yml'), 'utf8')
		);
		expect(findPermissionViolations(workflow)).toEqual([]);
	});
});
