import { describe, it, expect } from 'vitest';
import { applyApproval } from './approval';
import type { PendingManifest } from './review-report';

const base: PendingManifest = {
	generatedAt: '2026-07-06',
	sources: [
		{ sourceId: 'a', status: 'changed', oldHash: 'x', decision: 'pending' },
		{ sourceId: 'b', status: 'changed', oldHash: 'y', decision: 'pending' }
	]
};

describe('applyApproval', () => {
	it('flips only the named sources to approved', () => {
		const out = applyApproval(base, ['a']);
		expect(out.sources.find((s) => s.sourceId === 'a')?.decision).toBe('approved');
		expect(out.sources.find((s) => s.sourceId === 'b')?.decision).toBe('pending');
	});

	it('throws an opaque code for an unknown source id', () => {
		expect(() => applyApproval(base, ['nope'])).toThrow('E_REFRESH_UNKNOWN_SOURCE');
	});

	it('is idempotent', () => {
		const twice = applyApproval(applyApproval(base, ['a']), ['a']);
		expect(twice.sources.find((s) => s.sourceId === 'a')?.decision).toBe('approved');
	});
});
