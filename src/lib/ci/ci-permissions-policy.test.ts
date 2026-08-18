import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

	it('treats a job as covered by a write-free top-level permissions block', () => {
		const v = findPermissionViolations({ permissions: { contents: 'read' }, jobs: { build: {} } });
		expect(v).toEqual([]);
	});

	it('flags a top-level write-all inherited by a block-less job', () => {
		const v = findPermissionViolations({ permissions: 'write-all', jobs: { build: {} } });
		expect(v.some((m) => m.includes('write-all'))).toBe(true);
	});

	it('does not throw on an empty workflow file (a null parse)', () => {
		expect(() => findPermissionViolations(parse(''))).not.toThrow();
		expect(findPermissionViolations(parse(''))).toEqual([]);
	});
});

describe('every committed workflow is least-privilege', () => {
	const dir = join(process.cwd(), '.github', 'workflows');
	for (const file of readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))) {
		it(`${file} declares a write-free permissions block for every job`, () => {
			const workflow = parse(readFileSync(join(dir, file), 'utf8'));
			expect(findPermissionViolations(workflow)).toEqual([]);
		});
	}
});
