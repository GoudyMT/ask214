import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarSyncState } from '../calendar/types';
import { getDiagnosticsForTest } from '../log/safelog';
import { encodeEaos, parseEaosAtRead } from '../profile/eaos';
import type { ProfileV1 } from '../profile/types';
import { cleanListing } from '../skillbridge-finder/fixtures/clean';
import type { FinderRecord } from '../skillbridge-finder/state/types';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { SKILLBRIDGE_PLAN_KEY } from '../timeline/skillbridge-plan';
import type { TimelineState, TimelineTaskState } from '../timeline/types';
import { MAX_PADDED_PLAINTEXT_BYTES } from './caps';
import { buildExportInner } from './export-inner';
import { MAX_NOTE_UNITS } from './note-cap';
import type { Snapshot } from './snapshot';
import { validateInner } from './validate';

const encoded = vi.hoisted(() => ({
	kept: [] as { name: string; buffer: Uint8Array; copy: Uint8Array }[],
	inValidator: false
}));

// The validator is the real one; the spy only records whether it ran, and marks the time inside it so the buffers
// it makes for itself are not counted as the export's.
vi.mock('./validate', async (importOriginal) => {
	const real = await importOriginal<typeof import('./validate')>();
	return {
		...real,
		validateInner: vi.fn((...args: Parameters<typeof real.validateInner>) => {
			encoded.inValidator = true;
			try {
				return real.validateInner(...args);
			} finally {
				encoded.inValidator = false;
			}
		})
	};
});

const validateSpy = vi.mocked(validateInner);

// The real encoders; the wrapper only keeps each buffer it hands out (and a copy of what it held) so a test can look
// at those buffers after the export.
const keepBuffer = (name: string, buffer: Uint8Array): Uint8Array => {
	if (!encoded.inValidator) encoded.kept.push({ name, buffer, copy: buffer.slice() });
	return buffer;
};
vi.mock('../profile/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/codec')>();
	return {
		...real,
		encodeProfile: (...args: Parameters<typeof real.encodeProfile>) =>
			keepBuffer('profile', real.encodeProfile(...args))
	};
});
vi.mock('../timeline/state-codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../timeline/state-codec')>();
	return {
		...real,
		encodeTimelineState: (...args: Parameters<typeof real.encodeTimelineState>) =>
			keepBuffer('timeline', real.encodeTimelineState(...args))
	};
});
vi.mock('../calendar/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../calendar/codec')>();
	return {
		...real,
		encodeCalendarSyncState: (...args: Parameters<typeof real.encodeCalendarSyncState>) =>
			keepBuffer('calendar', real.encodeCalendarSyncState(...args))
	};
});

vi.mock('../skillbridge-finder/state/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../skillbridge-finder/state/codec')>();
	return {
		...real,
		encodeFinderRecord: (...args: Parameters<typeof real.encodeFinderRecord>) =>
			keepBuffer('finder', real.encodeFinderRecord(...args))
	};
});

type Bag = Record<string, unknown>;

const NOW = 1_760_000_000_000;
const CAP = MAX_PADDED_PLAINTEXT_BYTES;
const EURO = String.fromCharCode(0x20ac);
const date = (iso: string) => encodeEaos(parseEaosAtRead(iso));

beforeEach(() => {
	validateSpy.mockClear();
	encoded.kept.length = 0;
});

/** A finished setup as the profile store holds it, backup mark and all. */
function deviceProfile(extra: Partial<ProfileV1> = {}): ProfileV1 {
	return {
		schemaVersion: 1,
		generation: 4,
		lastSeenAt: NOW,
		setupIntent: 'completed',
		setupIntentChangedAt: NOW - 86_400_000,
		eaos: date('2027-06-30'),
		lastBackupAt: NOW - 1000,
		backupGenProfile: 3,
		backupGenTimeline: 1,
		backupGenCalendar: 1,
		backupGenFinder: 2,
		...extra
	};
}

function snapshot(over: Partial<Omit<Snapshot, 'ok'>> = {}): Snapshot {
	return {
		ok: true,
		profile: deviceProfile(),
		timeline: null,
		calendar: null,
		finder: null,
		gens: { profile: 4, timeline: 0, calendar: 0, finder: 0 },
		...over
	};
}

/** A finder record as the store holds it after a person has used the finder. */
function deviceFinder(over: Partial<FinderRecord> = {}): FinderRecord {
	return {
		schemaVersion: 1,
		finderSetup: { place: { kind: 'zip', zip: '21046' }, radius: 50, territories: true },
		finderFilters: { branches: ['Army'], delivery: [1] },
		finderSaved: [{ id: 1001, savedOn: '2026-10-21', facts: cleanListing() }],
		finderCompare: [1001],
		...over
	};
}

/** A timeline holding one note per known task id, in the order given. */
function timelineWithNotes(notes: string[]): TimelineState {
	const tasks: Record<string, TimelineTaskState> = {};
	for (const [i, id] of KNOWN_TASK_IDS.slice(0, notes.length).entries()) {
		const note = notes[i];
		if (note !== undefined) tasks[id] = { notes: note };
	}
	return { schemaVersion: 1, tasks };
}

function exported(snap: Snapshot, createdAt = NOW): Uint8Array {
	const result = buildExportInner(snap, createdAt);
	expect(result.ok).toBe(true);
	if (!result.ok) return new Uint8Array();
	return result.bytes;
}

const parse = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Bag;
const storesOf = (bytes: Uint8Array) => parse(bytes).stores as Bag;

describe('buildExportInner: what a person exports', () => {
	it('a device record exports and validates', () => {
		const timeline: TimelineState = {
			schemaVersion: 1,
			tasks: {
				'va-gov-account': { status: 'done' },
				'tap-course': {
					status: 'snoozed',
					snoozeUntil: '2027-01-15',
					notes: 'Call the TAP office'
				},
				[SKILLBRIDGE_PLAN_KEY]: { status: 'snoozed' }
			}
		};
		const calendar: CalendarSyncState = {
			schemaVersion: 1,
			exclusions: { taskIds: ['job-search'], categories: ['finance', 'medical'] },
			card: { dismissedAt: NOW, dismissCount: 2 }
		};
		const bytes = exported(snapshot({ timeline, calendar }));

		const result = validateInner(parse(bytes));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.inner.createdAt).toBe(NOW);
		expect(result.inner.appVersion).toBe(__APP_VERSION__);
		expect(result.inner.stores['timeline-state']).toEqual(timeline);
		expect(result.inner.stores['calendar-sync']).toEqual(calendar);
		expect(result.inner.stores.profile.setupIntent).toBe('completed');
	});

	// The calendar keeps the events handed to THIS phone's calendar app; a file made here must not name them.
	it("export omits the device's lastAdd", () => {
		const calendar: CalendarSyncState = {
			schemaVersion: 1,
			exclusions: { taskIds: [], categories: ['career'] },
			lastAdd: [
				{
					taskId: 'tap-course',
					moment: 'last',
					title: 'TAP course',
					isoDate: '2027-02-01',
					addedOn: '2027-01-10'
				}
			]
		};
		const stores = storesOf(exported(snapshot({ calendar })));
		expect(stores['calendar-sync']).toEqual({
			schemaVersion: 1,
			exclusions: { taskIds: [], categories: ['career'] }
		});
	});

	// A device that never used the finder must make the same file as before, so an older app can still open it.
	it('a store with no finder record exports no finder key', () => {
		const stores = storesOf(exported(snapshot()));
		expect(stores).not.toHaveProperty('skillbridge-finder');
		expect(Object.keys(stores).sort()).toEqual(['calendar-sync', 'profile', 'timeline-state']);
	});

	// A restore of an older file, or a person who took every pick away, leaves an empty record at a high generation. The
	// file made from it must be the one an older app opens, as for a device that never used the finder.
	// A place or a filter set that was set and then cleared stays in the store as an empty object, which is no data either.
	it.each([
		['nothing at all', {}],
		['a setup that was emptied', { finderSetup: {} }],
		['filters that were emptied', { finderFilters: {} }],
		// The store keeps a key a newer release added, in any shape; the file never carries it, so it is no data here.
		['only a filter a newer release added', { finderFilters: { regions: null } }]
	])('a finder record that holds %s exports no finder key', (_name, extra) => {
		const empty = {
			schemaVersion: 1,
			finderSaved: [],
			finderCompare: [],
			...extra
		} as FinderRecord;
		const stores = storesOf(
			exported(
				snapshot({ finder: empty, gens: { profile: 4, timeline: 0, calendar: 0, finder: 5 } })
			)
		);
		expect(stores).not.toHaveProperty('skillbridge-finder');
		expect(Object.keys(stores).sort()).toEqual(['calendar-sync', 'profile', 'timeline-state']);
	});

	// Each kind of saved choice alone is data: a person who only saved a place, or only a pick, keeps it in the file.
	it.each([
		['a place and reach', { finderSetup: { radius: 25 } }],
		['filters', { finderFilters: { kinds: ['internship'] } }],
		[
			'a saved program',
			{ finderSaved: [{ id: 1001, savedOn: '2026-10-21', facts: cleanListing() }] }
		],
		['a compare pick', { finderCompare: [1001] }]
	] as [string, Partial<FinderRecord>][])(
		'a finder record holding only %s exports',
		(_name, own) => {
			const finder: FinderRecord = { schemaVersion: 1, finderSaved: [], finderCompare: [], ...own };
			const stores = storesOf(
				exported(snapshot({ finder, gens: { profile: 4, timeline: 0, calendar: 0, finder: 2 } }))
			);
			expect(stores['skillbridge-finder']).toEqual(finder);
		}
	);

	it('a store with a finder record exports it, and it validates', () => {
		const finder = deviceFinder();
		const bytes = exported(
			snapshot({ finder, gens: { profile: 4, timeline: 0, calendar: 0, finder: 3 } })
		);

		expect(storesOf(bytes)['skillbridge-finder']).toEqual(finder);
		const result = validateInner(parse(bytes));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.inner.stores['skillbridge-finder']).toEqual(finder);
	});

	// The store keeps a key a newer release added, so an older tab's save does not drop it; the strict check on a restore
	// would refuse a file that carried it, so the file is built from the known fields only.
	it('export builds the finder record from its known fields and copies no key the store kept', () => {
		const kept = {
			...deviceFinder(),
			future: 'x',
			finderSetup: {
				place: { kind: 'zip', zip: '21046', future: 'x' },
				radius: 50,
				future: 'x'
			},
			finderFilters: { branches: ['Army'], future: ['x'] },
			finderSaved: [{ id: 1001, savedOn: '2026-10-21', facts: cleanListing(), future: 'x' }]
		} as unknown as FinderRecord;

		const bytes = exported(
			snapshot({ finder: kept, gens: { profile: 4, timeline: 0, calendar: 0, finder: 1 } })
		);

		expect(storesOf(bytes)['skillbridge-finder']).toEqual({
			schemaVersion: 1,
			finderSetup: { place: { kind: 'zip', zip: '21046' }, radius: 50 },
			finderFilters: { branches: ['Army'] },
			finderSaved: [{ id: 1001, savedOn: '2026-10-21', facts: cleanListing() }],
			finderCompare: [1001]
		});
		expect(validateInner(parse(bytes)).ok).toBe(true);
	});

	// The mark says which saved state this device last backed up; it describes the device, not the data.
	it('export omits the backup mark', () => {
		const profile = storesOf(exported(snapshot())).profile as Bag;
		for (const key of [
			'lastBackupAt',
			'backupGenProfile',
			'backupGenTimeline',
			'backupGenCalendar',
			'backupGenFinder'
		]) {
			expect(profile).not.toHaveProperty(key);
		}
		expect(profile).toHaveProperty('eaos');
	});

	// Two earlier releases could save a repeated category; the restore check refuses a repeat, so the export
	// writes each once, in the order first seen.
	it('a device calendar record with a duplicate category exports once and validates', () => {
		const calendar: CalendarSyncState = {
			schemaVersion: 1,
			exclusions: {
				taskIds: ['job-search', 'tap-course', 'job-search'],
				categories: ['finance', 'medical', 'finance']
			}
		};
		const bytes = exported(snapshot({ calendar }));
		expect(storesOf(bytes)['calendar-sync']).toEqual({
			schemaVersion: 1,
			exclusions: { taskIds: ['job-search', 'tap-course'], categories: ['finance', 'medical'] }
		});
		expect(validateInner(parse(bytes)).ok).toBe(true);
	});

	// The encoders hand back the person's dates and notes as bytes; once the export has read them they have no use, so
	// none may linger in memory after the export.
	it('an export leaves no profile, timeline, calendar or finder plaintext behind in the encoder buffers', () => {
		const timeline: TimelineState = {
			schemaVersion: 1,
			tasks: { 'tap-course': { notes: 'Call the TAP office' } }
		};
		const calendar: CalendarSyncState = {
			schemaVersion: 1,
			exclusions: { taskIds: ['job-search'], categories: ['finance'] }
		};
		exported(snapshot({ timeline, calendar, finder: deviceFinder() }));

		expect(encoded.kept.map((k) => k.name).sort()).toEqual([
			'calendar',
			'finder',
			'profile',
			'timeline'
		]);
		for (const { buffer, copy } of encoded.kept) {
			expect(copy.some((byte) => byte !== 0)).toBe(true);
			expect(buffer.every((byte) => byte === 0)).toBe(true);
		}
	});

	it('createdAt is written as given', () => {
		const clocks = [Date.UTC(2000, 0, 1), Date.now() + 365 * 86_400_000];
		for (const clock of clocks) {
			expect(parse(exported(snapshot(), clock)).createdAt).toBe(clock);
		}
	});
});

describe('buildExportInner: refusals', () => {
	// A note longer than today's limit can only come from an older release; the person needs to hear which task
	// to shorten, not that the file is faulty.
	it('a legacy 100,001-unit note reports CONTENT_TOO_LARGE naming its task, before validation', () => {
		const timeline: TimelineState = {
			schemaVersion: 1,
			tasks: { 'tap-course': { notes: 'a'.repeat(MAX_NOTE_UNITS + 1) } }
		};
		expect(buildExportInner(snapshot({ timeline }), NOW)).toEqual({
			ok: false,
			code: 'E_CONTENT_TOO_LARGE',
			taskId: 'tap-course'
		});
		expect(validateSpy).not.toHaveBeenCalled();
	});

	// The store was read fine, so a record the restore check would refuse is the app's fault, named by store.
	it.each([
		{
			store: 'profile',
			index: 0,
			over: { profile: deviceProfile({ yearsOfService: 5 }) }
		},
		{
			store: 'timeline',
			index: 1,
			over: {
				timeline: { schemaVersion: 1, tasks: { 'not-a-task': { status: 'done' } } } as TimelineState
			}
		},
		{
			store: 'calendar',
			index: 2,
			over: {
				calendar: {
					schemaVersion: 1,
					exclusions: { taskIds: ['not-a-task'], categories: [] }
				} as CalendarSyncState
			}
		},
		{
			store: 'finder',
			index: 3,
			over: {
				// A saved program whose facts name another id: the store would refuse to read it back, and so would a restore.
				finder: deviceFinder({
					finderSaved: [{ id: 1002, savedOn: '2026-10-21', facts: cleanListing() }]
				})
			}
		}
	])(
		'an export whose own $store fails validation reports EXPORT_SELF_INVALID and logs it',
		({ store, index, over }) => {
			expect(buildExportInner(snapshot(over), NOW)).toEqual({
				ok: false,
				code: 'E_EXPORT_SELF_INVALID',
				store
			});
			expect(getDiagnosticsForTest().at(-1)).toMatchObject({
				code: 'E_EXPORT_SELF_INVALID',
				fields: { store: index }
			});
		}
	);
});

describe('buildExportInner: the size cap', () => {
	const TWENTY_EURO_NOTES = Array.from({ length: 20 }, () => EURO.repeat(MAX_NOTE_UNITS));

	/**
	 * A filler note that brings the encoded inner to exactly the cap: 20 notes of 100,000 euro signs plus this one
	 * (21 notes; one note alone can reach 600,000 bytes at most). The size is measured on the real export.
	 */
	function fillerForExactCap(): string {
		const probe = exported(snapshot({ timeline: timelineWithNotes([...TWENTY_EURO_NOTES, 'a']) }));
		const missing = CAP - probe.length;
		const euros = Math.floor(missing / 3);
		const filler = 'a' + EURO.repeat(euros) + 'a'.repeat(missing - euros * 3);
		expect(filler.length).toBeLessThanOrEqual(MAX_NOTE_UNITS);
		return filler;
	}

	const withFiller = (filler: string) => [...TWENTY_EURO_NOTES, filler];

	it('inner exactly at the cap returns its bytes', () => {
		const notes = withFiller(fillerForExactCap());
		expect(notes.length).toBeGreaterThanOrEqual(11);
		const result = buildExportInner(snapshot({ timeline: timelineWithNotes(notes) }), NOW);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bytes.length).toBe(CAP);
	});

	it('cap + 1 byte is CONTENT_TOO_LARGE', () => {
		const notes = withFiller(fillerForExactCap() + 'a');
		const result = buildExportInner(snapshot({ timeline: timelineWithNotes(notes) }), NOW);
		expect(result).toMatchObject({ ok: false, code: 'E_CONTENT_TOO_LARGE' });
	});

	// Control characters travel as six bytes each, so 50,000 of them outweigh 100,000 plain letters.
	it('the named task is the one with the largest JSON-encoded note', () => {
		const control = String.fromCharCode(1).repeat(50_000);
		const plain = 'a'.repeat(MAX_NOTE_UNITS);
		const euros = Array.from({ length: 20 }, () => EURO.repeat(99_000));
		const timeline = timelineWithNotes([plain, control, ...euros]);
		const ids = KNOWN_TASK_IDS.slice(0, 22);
		expect(
			JSON.stringify(control).length > JSON.stringify(plain).length && control.length < plain.length
		).toBe(true);
		expect(buildExportInner(snapshot({ timeline }), NOW)).toEqual({
			ok: false,
			code: 'E_CONTENT_TOO_LARGE',
			taskId: ids[1]
		});
	});
});
