import { describe, it, expect } from 'vitest';
import { buildIcs } from './build-ics';
import { computeIcsUid } from './uid';
import type { TimelineItem } from '../timeline/generate';

const NOW = new Date('2026-10-03T12:00:00Z');

describe('buildIcs', () => {
	it('keeps the per-task calendar ID on the "Last day" event and keys the other moments apart', async () => {
		const bdd: TimelineItem = {
			def: {
				id: 'bdd',
				title: 'BDD',
				category: 'benefits',
				track: 'transition',
				kind: 'closes',
				windowStart: -180,
				windowEnd: -90,
				why: '',
				afterNote: 'n'
			},
			targetDate: '2026-11-01',
			windowStartDate: '2026-11-01',
			windowEndDate: '2027-02-01',
			status: 'upcoming'
		};
		// A UID line is 78 octets, so it always folds: join the folds before reading.
		const ics = (await buildIcs([bdd], { taskIds: [], categories: [] }, NOW)).replace(/\r\n /g, '');
		// A re-add then updates the event a user already has instead of duplicating it.
		expect(ics).toContain(`UID:${await computeIcsUid('bdd')}\r\n`);
		expect(ics).toContain(`UID:${await computeIcsUid('bdd:opens')}\r\n`);
	});
});
