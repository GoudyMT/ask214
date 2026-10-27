import { describe, expect, it } from 'vitest';
import type { HandedOverEvent } from '../calendar/types';
import { encodeProfile } from '../profile/codec';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import type { ProfileV1 } from '../profile/types';
import { composeRestore, type DeviceMarks } from './restore-writer';
import { validateInner, type ValidInner } from './validate';

const NOW = Date.UTC(2026, 9, 20);
const DAY = 86_400_000;

type Bag = Record<string, unknown>;

/** A backup made on another phone, run through the real validator. */
function fileInner(): ValidInner {
	const date = (iso: string) => encodeEaos(parseEaosAtRead(iso));
	const profile = JSON.parse(
		new TextDecoder().decode(
			encodeProfile({
				schemaVersion: 1,
				generation: 41,
				lastSeenAt: NOW - 40 * DAY,
				setupIntent: 'completed',
				setupIntentChangedAt: NOW - 90 * DAY,
				eaos: date('2028-02-01'),
				terminalLeaveStart: date('2028-01-01')
			})
		)
	) as Bag;
	const checked = validateInner(
		JSON.parse(
			JSON.stringify({
				appVersion: __APP_VERSION__,
				backupSchema: 1,
				createdAt: NOW - 5 * DAY,
				stores: {
					profile,
					'timeline-state': {
						schemaVersion: 1,
						tasks: { 'job-search': { status: 'done' } }
					},
					'calendar-sync': {
						schemaVersion: 1,
						exclusions: { taskIds: ['will-poa'], categories: ['finance'] }
					}
				}
			})
		) as unknown
	);
	if (!checked.ok) throw new Error('test setup: the file does not validate');
	return checked.inner;
}

const DEVICE: DeviceMarks = {
	gens: { profile: 3, timeline: 4, calendar: 2, finder: 0 },
	lastSeenAt: NOW - 10 * DAY,
	tsProfile: NOW - 12 * DAY,
	lastAdd: undefined
};

function compose(device: DeviceMarks, at = NOW) {
	const held = { staged: [] as Uint8Array[], records: [] as ProfileV1[] };
	return { out: composeRestore(fileInner(), device, at, held), held };
}

describe('composeRestore', () => {
	it('gives the same records for the same input, so a second run of the writer matches the first', () => {
		const a = compose(DEVICE).out;
		const b = compose(DEVICE).out;

		expect(b).toStrictEqual(a);
	});

	it('moves every store one step past the device and marks the backup at those numbers', () => {
		const { gens, profile } = compose(DEVICE).out;

		expect(gens).toStrictEqual({ profile: 4, timeline: 5, calendar: 3, finder: 1 });
		expect(profile).toMatchObject({
			generation: 4,
			backupGenProfile: 4,
			backupGenTimeline: 5,
			backupGenCalendar: 3,
			backupGenFinder: 1
		});
	});

	it.each([
		['the device clock mark is ahead of its profile marker', NOW - 3 * DAY, NOW - 9 * DAY],
		['the profile marker is ahead of the clock mark', NOW - 9 * DAY, NOW - 3 * DAY],
		['only the marker can be read', null, NOW - 3 * DAY]
	])(
		'never sets the clock mark below the larger of the two: %s',
		(_what, lastSeenAt, tsProfile) => {
			// A clock a month behind the marks: the mark may stay where it was, never go back.
			const at = NOW - 30 * DAY;
			const { profile } = compose({ ...DEVICE, lastSeenAt, tsProfile }, at).out;

			expect(profile.lastSeenAt).toBe(Math.max(lastSeenAt ?? 0, tsProfile));
		}
	);

	it('keeps the handed-over events when it is given them, and holds none when it is not', () => {
		const events: HandedOverEvent[] = [
			{
				taskId: 'job-search',
				moment: 'opens',
				title: 'Start the job search',
				isoDate: '2999-01-01',
				addedOn: '2026-10-16'
			}
		];

		expect(compose({ ...DEVICE, lastAdd: events }).out.calendar.lastAdd).toStrictEqual(events);
		expect(compose(DEVICE).out.calendar).not.toHaveProperty('lastAdd');
	});

	it('hands every plaintext buffer it made to the caller to wipe', () => {
		const { held } = compose(DEVICE);

		expect(held.staged.length).toBeGreaterThan(0);
		expect(held.records.length).toBeGreaterThan(0);
	});
});
