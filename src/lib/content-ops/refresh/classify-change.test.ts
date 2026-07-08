import { describe, it, expect } from 'vitest';
import { classifyChange } from './classify-change';

describe('classifyChange', () => {
	const baseline = {
		sourceId: 'va_intent_to_file',
		contentHash: 'aaa',
		sourceUpdatedDate: '2025-12-04'
	};

	it('flags a content-hash mismatch as changed', () => {
		const r = classifyChange(baseline, { hash: 'bbb' });
		expect(r.status).toBe('changed');
		expect(r.newHash).toBe('bbb');
		expect(r.reason).toBe('content hash differs');
	});

	it('flags an identical hash as unchanged', () => {
		expect(classifyChange(baseline, { hash: 'aaa' }).status).toBe('unchanged');
	});

	it('flags an unfetchable source as manual-check-required', () => {
		expect(classifyChange(baseline, { unfetchable: true }).status).toBe('manual-check-required');
	});

	it('flags a newer source date as changed when the hash is unknown', () => {
		const r = classifyChange(baseline, { updatedDate: '2026-03-01' });
		expect(r.status).toBe('changed');
		expect(r.reason).toBe('source date is newer');
	});

	it('omits (does not set undefined) optional fields when absent', () => {
		const r = classifyChange({ sourceId: 's', contentHash: 'h' }, { unfetchable: true });
		expect(Object.prototype.hasOwnProperty.call(r, 'newHash')).toBe(false);
		expect(Object.prototype.hasOwnProperty.call(r, 'oldDate')).toBe(false);
	});
});
