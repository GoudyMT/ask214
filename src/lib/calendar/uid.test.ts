import { describe, it, expect } from 'vitest';
import { computeIcsUid } from './uid';

describe('computeIcsUid', () => {
	it('is deterministic and stable for a task id', async () => {
		expect(await computeIcsUid('va-disability-claim')).toBe(
			await computeIcsUid('va-disability-claim')
		);
	});

	it('differs across task ids and ends in the fixed namespace', async () => {
		const a = await computeIcsUid('a');
		const b = await computeIcsUid('b');
		expect(a).not.toBe(b);
		expect(a.endsWith('@mtc.local')).toBe(true);
		expect(a).toMatch(/^[0-9a-f]{64}@mtc\.local$/);
	});
});
