import { describe, it, expect } from 'vitest';
import { generateTimeline, type TimelineView } from './generate';
import { TASK_DEFS } from './task-defs';
import type { PersonaFilters } from '../profile/persona';
import type { EaosString } from '../profile/eaos';
import type { TimelineState } from './types';

// A fixed local today, so the frozen view never moves with the real clock.
const TODAY = new Date(2026, 9, 4, 12);

const persona = (eaos: string, daysUntilSeparation: number): PersonaFilters => ({
	completeness: 'eaos-only',
	eaos: eaos as EaosString,
	daysUntilSeparation
});

const STATE: TimelineState = {
	schemaVersion: 1,
	tasks: {
		'va-gov-account': { status: 'done' },
		'master-resume': { status: 'snoozed', snoozeUntil: '2026-11-15' },
		'tap-capstone': { notes: 'n' }
	}
};

/** Every field a user sees, per phase; `def` is reduced to its id and kind because its shape changes. */
function project(view: TimelineView) {
	return {
		total: view.total,
		todayMarkerIndex: view.todayMarkerIndex,
		daysToSeparation: view.daysToSeparation,
		phases: view.phases.map((p) => ({
			bucket: p.bucket.id,
			counts: p.counts,
			collapsible: p.collapsible,
			items: p.items.map((i) => ({
				id: i.def.id,
				kind: i.def.kind,
				status: i.status,
				targetDate: i.targetDate,
				windowStartDate: i.windowStartDate,
				windowEndDate: i.windowEndDate,
				finalEndDate: i.finalEndDate,
				daysLeft: i.daysLeft,
				aimDate: i.aimDate,
				snoozeUntil: i.snoozeUntil,
				note: i.note
			}))
		}))
	};
}

describe('the no-dates view is v1.2.0 exactly', () => {
	it('matches the frozen view for three separation dates', async () => {
		const views = [
			persona('2027-04-30', 208),
			persona('2026-12-15', 72),
			persona('2026-08-01', -64)
		].map((p) => project(generateTimeline(p, [...TASK_DEFS], STATE, TODAY)));
		// Tab-indented with a final newline: the same bytes the repo's formatter writes, so it never rewrites the file.
		await expect(JSON.stringify(views, null, '\t') + '\n').toMatchFileSnapshot(
			'./__snapshots__/no-dates-v1.2.0.json'
		);
	});
});
