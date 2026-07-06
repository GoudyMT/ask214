import { describe, it, expect } from 'vitest';
import { computeContentRevision } from './content-revision';

const chunks = [
	{ id: 'b:2', text: 'second' },
	{ id: 'a:1', text: 'first' }
];

describe('computeContentRevision', () => {
	it('is deterministic and order-independent (sorts by id)', () => {
		const r1 = computeContentRevision(chunks, '2026-07-06');
		const r2 = computeContentRevision([...chunks].reverse(), '2026-07-06');
		expect(r1.contentHash).toBe(r2.contentHash);
		expect(r1.contentHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('changes the hash when any chunk text changes', () => {
		const r1 = computeContentRevision(chunks, '2026-07-06');
		const r2 = computeContentRevision(
			[
				{ id: 'a:1', text: 'CHANGED' },
				{ id: 'b:2', text: 'second' }
			],
			'2026-07-06'
		);
		expect(r1.contentHash).not.toBe(r2.contentHash);
	});

	it('passes the build date through', () => {
		expect(computeContentRevision(chunks, '2026-07-06').buildDate).toBe('2026-07-06');
	});
});
