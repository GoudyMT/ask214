import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeCalendarSyncState } from '../calendar/codec';
import type { CalendarSyncState, DesiredEvent } from '../calendar/types';
import { createCalendarSyncStore, type CalendarSyncStore } from '../calendar/store.svelte';
import { deleteTestDb, openTestDb } from '../db/_test-helpers';
import { bootstrapLocalKeystore } from '../keystore/bootstrap';
import { decodeProfile } from '../profile/codec';
import { encodeEaos, validateEaosAtInput } from '../profile/eaos';
import { zeroizeRecord } from '../profile/lifecycle';
import { createProfileStore, type ProfilePatch, type ProfileStore } from '../profile/store.svelte';
import type { ProfileV1 } from '../profile/types';
import { SNOOZE_DATE_MAX } from '../timeline/day-check';
import { addDays, localTodayIso } from '../timeline/day-math';
import { SKILLBRIDGE_PLAN_KEY, type PlanAnswer } from '../timeline/skillbridge-plan';
import { savePlanAnswer } from '../timeline/skillbridge-save';
import { createTimelineStateStore, type TimelineStateStore } from '../timeline/state.svelte';
import { decodeTimelineState } from '../timeline/state-codec';
import { TASK_DEFS } from '../timeline/task-defs';
import type { TimelineState } from '../timeline/types';
import { buildExportInner } from './export-inner';
import { MAX_NOTE_UNITS } from './note-cap';
import { takeSnapshot, type Snapshot } from './snapshot';
import { validateInner } from './validate';

// Every member below is something a screen can really do, driven through the same public setter the screen calls, on a
// real IndexedDB. A person who makes a backup must never be told that a record the app itself wrote is not fit to
// export, and a restore must never refuse one. A new public setter on any of the three stores belongs here too.

const DAY_MS = 86_400_000;

type Ctx = {
	profile: ProfileStore;
	timeline: TimelineStateStore;
	calendar: CalendarSyncStore;
	/** The separation date the first-run screen saved. */
	eaos: string;
	/** The local day on the clock the member runs under. */
	today: string;
};

/** The device record read back, and the file's three records decoded by the shipped decoders. */
type Seen = {
	snap: Snapshot;
	file: {
		profile: ProfileV1;
		timeline: TimelineState | null;
		calendar: CalendarSyncState | null;
	};
	ctx: Ctx;
};

type Member = {
	name: string;
	run: (ctx: Ctx) => Promise<void>;
	/** Literal checks that the member really wrote the record it is named for. */
	holds?: (seen: Seen) => void;
};

// Wizard and Settings validate a typed date against the clock, so a date is built from the clock the member runs under.
const dateBytes = (iso: string): Uint8Array => encodeEaos(validateEaosAtInput(iso));

async function saveDate(ctx: Ctx, patch: (bytes: Uint8Array) => ProfilePatch, iso: string) {
	const bytes = dateBytes(iso);
	try {
		await ctx.profile.save(patch(bytes));
	} finally {
		// The store keeps its own copy; this one held the typed date.
		bytes.fill(0);
	}
}

const leaveSkillbridge = (ctx: Ctx, iso: string) =>
	saveDate(ctx, (skillbridgeStart) => ({ skillbridgeStart }), iso);
const leaveTerminal = (ctx: Ctx, iso: string) =>
	saveDate(ctx, (terminalLeaveStart) => ({ terminalLeaveStart }), iso);
const moveEaos = (ctx: Ctx, iso: string) => saveDate(ctx, (eaos) => ({ eaos }), iso);

// The Settings leaving dates, in the order Settings requires: SkillBridge, then terminal leave, both before separation.
const skillbridgeIso = (ctx: Ctx) => addDays(ctx.eaos, -100);
const terminalIso = (ctx: Ctx) => addDays(ctx.eaos, -60);

async function bothLeavingDates(ctx: Ctx) {
	await leaveSkillbridge(ctx, skillbridgeIso(ctx));
	await leaveTerminal(ctx, terminalIso(ctx));
}

const text = (bytes: Uint8Array | undefined): string | undefined =>
	bytes ? new TextDecoder().decode(bytes) : undefined;

async function eachTask(fn: (id: string) => Promise<void>) {
	for (const def of TASK_DEFS) {
		// One record holds every task and each write replaces it whole, so the calls cannot overlap.
		await fn(def.id);
	}
}

// ---- Timeline ----------------------------------------------------------------------------------------------------

const BIG_NOTE = 'n'.repeat(MAX_NOTE_UNITS);
// Emoji (a surrogate pair), Hebrew and Arabic text, a right-to-left override, a quote and a backslash: everything the
// JSON text of a note has to escape or keep apart.
const MIXED_NOTE = [
	'call ',
	String.fromCharCode(0xd83d, 0xde00),
	' ',
	String.fromCharCode(0x5e9, 0x5dc, 0x5d5, 0x5dd),
	' ',
	String.fromCharCode(0x645, 0x631, 0x62d, 0x628, 0x627),
	' ',
	String.fromCharCode(0x202e),
	' "quoted" back',
	String.fromCharCode(0x5c),
	'slash'
].join('');

/** Every task id holds exactly this entry. */
function everyTaskIs(seen: Seen, entry: Record<string, unknown>) {
	const tasks = seen.snap.timeline?.tasks ?? {};
	expect(Object.keys(tasks).sort()).toEqual(TASK_DEFS.map((def) => def.id).sort());
	for (const def of TASK_DEFS) expect(tasks[def.id]).toStrictEqual(entry);
}

// Status and note are separate fields, so each covers every value once across the six members, and every member sets
// every task id.
const TIMELINE_MEMBERS: Member[] = [
	{
		name: 'timeline: every task done, note x',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, 'x');
				await ctx.timeline.setStatus(id, 'done');
			}),
		holds: (seen) => everyTaskIs(seen, { notes: 'x', status: 'done' })
	},
	{
		name: 'timeline: every task skipped, 100,000-unit note',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, BIG_NOTE);
				await ctx.timeline.setStatus(id, 'skipped');
			}),
		holds: (seen) => everyTaskIs(seen, { notes: BIG_NOTE, status: 'skipped' })
	},
	{
		name: 'timeline: every task snoozed with no date, emoji and right-to-left note',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, MIXED_NOTE);
				await ctx.timeline.setStatus(id, 'snoozed');
			}),
		holds: (seen) => everyTaskIs(seen, { notes: MIXED_NOTE, status: 'snoozed' })
	},
	{
		name: 'timeline: every task done then cleared, blank-space note',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, '   ');
				await ctx.timeline.setStatus(id, 'done');
				await ctx.timeline.setStatus(id, undefined);
			}),
		holds: (seen) => everyTaskIs(seen, { notes: '   ' })
	},
	{
		name: 'timeline: every task snoozed to a date, newline note',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, '\n');
				await ctx.timeline.setSnooze(id, addDays(ctx.today, 7));
			}),
		holds: (seen) =>
			everyTaskIs(seen, {
				notes: '\n',
				snoozeUntil: addDays(seen.ctx.today, 7),
				status: 'snoozed'
			})
	},
	{
		name: 'timeline: every task snoozed to the last day a snooze can name, note cleared',
		run: (ctx) =>
			eachTask(async (id) => {
				await ctx.timeline.setNote(id, 'x');
				await ctx.timeline.setNote(id, '');
				await ctx.timeline.setSnooze(id, SNOOZE_DATE_MAX);
			}),
		holds: (seen) => everyTaskIs(seen, { snoozeUntil: SNOOZE_DATE_MAX, status: 'snoozed' })
	},
	{
		name: 'timeline: a task set and then cleared leaves an empty record',
		run: async (ctx) => {
			const id = TASK_DEFS[0]?.id ?? '';
			await ctx.timeline.setStatus(id, 'done');
			await ctx.timeline.setNote(id, 'x');
			await ctx.timeline.setStatus(id, undefined);
			await ctx.timeline.setNote(id, '');
		},
		holds: (seen) => expect(seen.snap.timeline?.tasks).toStrictEqual({})
	}
];

// The SkillBridge answer is one entry under its own key. A separation date far out makes a "Not sure" early (it comes
// back as a snooze to a date); a near one makes it late (the steps show).
const FAR_DAYS = 700;
const NEAR_DAYS = 100;
const ASK_AGAIN_DAYS = 456;

function planMember(
	name: string,
	answer: PlanAnswer,
	separation: (ctx: Ctx) => string,
	entry: (ctx: Ctx) => Record<string, string>
): Member {
	return {
		name: `plan: ${name}`,
		run: async (ctx) => {
			await savePlanAnswer(ctx.timeline, answer, separation(ctx), ctx.today);
		},
		holds: (seen) =>
			expect(seen.snap.timeline?.tasks[SKILLBRIDGE_PLAN_KEY]).toStrictEqual(entry(seen.ctx))
	};
}

const PLAN_MEMBERS: Member[] = [
	planMember(
		'yes',
		'yes',
		(ctx) => ctx.eaos,
		() => ({ status: 'done' })
	),
	planMember(
		'no',
		'no',
		(ctx) => ctx.eaos,
		() => ({ status: 'skipped' })
	),
	planMember(
		'not sure, early',
		'not-sure',
		(ctx) => addDays(ctx.today, FAR_DAYS),
		(ctx) => ({
			status: 'snoozed',
			snoozeUntil: addDays(addDays(ctx.today, FAR_DAYS), -ASK_AGAIN_DAYS)
		})
	),
	planMember(
		'not sure, late',
		'not-sure',
		(ctx) => addDays(ctx.today, NEAR_DAYS),
		() => ({ status: 'snoozed' })
	)
];

// ---- Calendar ----------------------------------------------------------------------------------------------------

const ALL_TASK_IDS = TASK_DEFS.map((def) => def.id);
const ALL_CATEGORIES = ['medical', 'admin', 'benefits', 'career', 'finance'] as const;

/** Three events of three moments, as the calendar page hands them over; the dates are ahead of the member's clock. */
const eventsFor = (ctx: Ctx): DesiredEvent[] =>
	(['opens', 'last', 'aim'] as const).map((moment, index) => ({
		taskId: ALL_TASK_IDS[index] ?? '',
		moment,
		title: `task ${index}`,
		isoDate: addDays(ctx.today, 10 + index),
		alarmDays: [1]
	}));

const dismissFourTimes = async (ctx: Ctx) => {
	for (let n = 0; n < 4; n++) {
		// Each dismissal builds on the count the one before saved.
		await ctx.calendar.dismissCard(Date.now());
	}
};

const CALENDAR_MEMBERS: Member[] = [
	{
		name: 'calendar: setExclusions with every category and every task',
		run: (ctx) =>
			ctx.calendar.setExclusions({ taskIds: ALL_TASK_IDS, categories: [...ALL_CATEGORIES] }),
		holds: (seen) =>
			expect(seen.snap.calendar?.exclusions).toStrictEqual({
				taskIds: ALL_TASK_IDS,
				categories: [...ALL_CATEGORIES]
			})
	},
	{
		name: 'calendar: setExclusions from the saved set, adding and removing',
		run: async (ctx) => {
			for (const category of ALL_CATEGORIES) {
				await ctx.calendar.setExclusions((current) => ({
					...current,
					categories: [...current.categories, category]
				}));
			}
			await ctx.calendar.setExclusions((current) => ({
				taskIds: [...current.taskIds, 'job-search', 'tap-course'],
				categories: current.categories.filter((category) => category !== 'career')
			}));
		},
		holds: (seen) =>
			expect(seen.snap.calendar?.exclusions).toStrictEqual({
				taskIds: ['job-search', 'tap-course'],
				categories: ['medical', 'admin', 'benefits', 'finance']
			})
	},
	{
		name: 'calendar: dismissCard four times',
		run: dismissFourTimes,
		holds: (seen) => expect(seen.snap.calendar?.card?.dismissCount).toBe(4)
	},
	{
		name: 'calendar: recordAdd then acknowledgeStale for one event',
		run: async (ctx) => {
			const events = eventsFor(ctx);
			await ctx.calendar.recordAdd(events, ctx.today, ctx.today);
			const [first] = ctx.calendar.lastAdd ?? [];
			await ctx.calendar.acknowledgeStale(first ? [first] : []);
		},
		// The device keeps the list; the file leaves it out.
		holds: (seen) => {
			expect(seen.snap.calendar?.lastAdd).toHaveLength(2);
			expect(seen.file.calendar).not.toHaveProperty('lastAdd');
		}
	},
	{
		name: 'calendar: exclusions, four dismissals and an add, then every event acknowledged',
		run: async (ctx) => {
			await ctx.calendar.setExclusions({ taskIds: ALL_TASK_IDS, categories: [...ALL_CATEGORIES] });
			await dismissFourTimes(ctx);
			await ctx.calendar.recordAdd(eventsFor(ctx), ctx.today, ctx.today);
			await ctx.calendar.acknowledgeStale(ctx.calendar.lastAdd ?? []);
		},
		holds: (seen) => {
			expect(seen.snap.calendar?.lastAdd).toStrictEqual([]);
			expect(seen.snap.calendar?.card?.dismissCount).toBe(4);
			expect(seen.file.calendar?.exclusions.taskIds).toStrictEqual(ALL_TASK_IDS);
		}
	},
	// The toggle that shipped between 2026-07-16 and 2026-10-04 could save a category twice. The setter takes whatever
	// list it is given, so the same record can still be written through it.
	{
		name: 'calendar: the historic duplicate-category shape, written through setExclusions',
		run: async (ctx) => {
			await ctx.calendar.setExclusions({
				taskIds: ['job-search'],
				categories: ['finance', 'medical']
			});
			await ctx.calendar.setExclusions((current) => ({
				taskIds: [...current.taskIds, 'job-search'],
				categories: [...current.categories, 'finance']
			}));
		},
		holds: (seen) => {
			expect(seen.snap.calendar?.exclusions).toStrictEqual({
				taskIds: ['job-search', 'job-search'],
				categories: ['finance', 'medical', 'finance']
			});
			expect(seen.file.calendar?.exclusions).toStrictEqual({
				taskIds: ['job-search'],
				categories: ['finance', 'medical']
			});
		}
	}
];

// ---- Profile -----------------------------------------------------------------------------------------------------

const PROFILE_MEMBERS: Member[] = [
	{
		name: 'profile: the first-run save alone',
		run: () => Promise.resolve(),
		holds: (seen) => {
			expect(text(seen.snap.profile.eaos ?? undefined)).toBe(seen.ctx.eaos);
			expect(seen.snap.profile.setupIntent).toBe('completed');
		}
	},
	{
		name: 'profile: SkillBridge and terminal leave both before separation',
		run: bothLeavingDates,
		holds: (seen) => {
			expect(text(seen.file.profile.skillbridgeStart)).toBe(skillbridgeIso(seen.ctx));
			expect(text(seen.file.profile.terminalLeaveStart)).toBe(terminalIso(seen.ctx));
		}
	},
	// Settings refuses to save a leaving date on or after separation, so such a date is stored only when the separation
	// date is moved to it afterwards.
	{
		name: 'profile: separation moved onto the SkillBridge day',
		run: async (ctx) => {
			await bothLeavingDates(ctx);
			await moveEaos(ctx, skillbridgeIso(ctx));
		},
		holds: (seen) =>
			expect(text(seen.file.profile.eaos ?? undefined)).toBe(skillbridgeIso(seen.ctx))
	},
	{
		name: 'profile: separation moved before both leaving dates',
		run: async (ctx) => {
			await bothLeavingDates(ctx);
			await moveEaos(ctx, addDays(ctx.eaos, -200));
		},
		holds: (seen) =>
			expect(text(seen.file.profile.eaos ?? undefined)).toBe(addDays(seen.ctx.eaos, -200))
	},
	{
		name: 'profile: SkillBridge date cleared, terminal leave kept',
		run: async (ctx) => {
			await bothLeavingDates(ctx);
			await ctx.profile.save({ skillbridgeStart: undefined });
		},
		holds: (seen) => {
			expect(seen.file.profile.skillbridgeStart).toBeUndefined();
			expect(text(seen.file.profile.terminalLeaveStart)).toBe(terminalIso(seen.ctx));
		}
	},
	{
		name: 'profile: both leaving dates cleared',
		run: async (ctx) => {
			await bothLeavingDates(ctx);
			await ctx.profile.save({ skillbridgeStart: undefined });
			await ctx.profile.save({ terminalLeaveStart: undefined });
		},
		holds: (seen) => {
			expect(seen.file.profile.skillbridgeStart).toBeUndefined();
			expect(seen.file.profile.terminalLeaveStart).toBeUndefined();
		}
	},
	// Only a clock that moved back makes this do anything; under the other clocks it still has to leave a record that
	// exports.
	{
		name: 'profile: clearClockBackward',
		run: (ctx) => ctx.profile.clearClockBackward(),
		holds: (seen) => expect(seen.snap.profile.lastSeenAt).toBeLessThanOrEqual(Date.now())
	}
];

const MEMBERS: Member[] = [
	...TIMELINE_MEMBERS,
	...PLAN_MEMBERS,
	...CALENDAR_MEMBERS,
	...PROFILE_MEMBERS
];

// ---- Clocks ------------------------------------------------------------------------------------------------------

// `deviceAt` is the clock while the device is set up (null = the real one); `memberAt` is where the clock is moved to
// before the member's setters and the export run (absent = left where it is).
type Clock = {
	name: string;
	deviceAt: (real: number) => number | null;
	memberAt?: (real: number) => number;
};

const CLOCKS: Clock[] = [
	{ name: 'real now', deviceAt: () => null },
	// Set up and saved at the real time, then the clock goes back two days: the saved last-seen time is now ahead.
	{
		name: 'two days back after a backup made now',
		deviceAt: () => null,
		memberAt: (real) => real - 2 * DAY_MS
	},
	{ name: '2000-01-01T00:00:00Z', deviceAt: () => Date.UTC(2000, 0, 1) },
	{ name: 'one year ahead', deviceAt: (real) => real + 365 * DAY_MS }
];

afterEach(() => {
	vi.useRealTimers();
});

function setClock(ms: number) {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(ms);
}

/** The wizard's save, then a loaded timeline and calendar store, as a person who has finished setup has. */
async function finishedDevice(db: IDBDatabase, clock: Clock) {
	const deviceAt = clock.deviceAt(Date.now());
	if (deviceAt !== null) setClock(deviceAt);
	await bootstrapLocalKeystore(db);
	const profile = createProfileStore(db);
	const eaos = addDays(localTodayIso(new Date()), 400);
	const bytes = encodeEaos(validateEaosAtInput(eaos));
	try {
		await profile.save({ eaos: bytes, setupIntent: 'completed' });
	} finally {
		bytes.fill(0);
	}
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	if (clock.memberAt) setClock(clock.memberAt(Date.now()));
	return { profile, timeline, calendar, eaos, today: localTodayIso(new Date()) } satisfies Ctx;
}

const wire = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** The device record without the four backup-mark fields, which the file never carries. */
function withoutBackupMark(profile: ProfileV1): ProfileV1 {
	const copy: ProfileV1 = { ...profile };
	delete copy.lastBackupAt;
	delete copy.backupGenProfile;
	delete copy.backupGenTimeline;
	delete copy.backupGenCalendar;
	return copy;
}

/** The device calendar without `lastAdd`, each list once in first-seen order. */
function withoutDeviceOnly(calendar: CalendarSyncState): CalendarSyncState {
	return {
		schemaVersion: calendar.schemaVersion,
		exclusions: {
			taskIds: [...new Set(calendar.exclusions.taskIds)],
			categories: [...new Set(calendar.exclusions.categories)]
		},
		...(calendar.card && { card: calendar.card })
	};
}

/** Snapshot, export, validate and decode the file's three records; every check a restore's reader would make. */
async function exportAndReadBack(db: IDBDatabase, ctx: Ctx, member: Member) {
	const snap = await takeSnapshot(db);
	expect(snap.ok).toBe(true);
	if (!snap.ok) return;
	const toWipe: Record<string, unknown>[] = [snap.profile as unknown as Record<string, unknown>];
	try {
		const createdAt = Date.now();
		const built = buildExportInner(snap, createdAt);
		expect(built).toMatchObject({ ok: true });
		if (!built.ok) return;
		const checked = validateInner(JSON.parse(new TextDecoder().decode(built.bytes)));
		built.bytes.fill(0);
		expect(checked).toMatchObject({ ok: true });
		if (!checked.ok) return;
		expect(checked.inner.createdAt).toBe(createdAt);

		const stores = checked.inner.stores;
		const profileWire = wire(stores.profile);
		const profile = decodeProfile(profileWire);
		profileWire.fill(0);
		toWipe.push(profile as unknown as Record<string, unknown>);
		const timeline = stores['timeline-state']
			? decodeTimelineState(wire(stores['timeline-state']))
			: null;
		const calendar = stores['calendar-sync']
			? decodeCalendarSyncState(wire(stores['calendar-sync']))
			: null;

		expect(profile).toStrictEqual(withoutBackupMark(snap.profile));
		expect(timeline).toStrictEqual(snap.timeline);
		expect(calendar).toStrictEqual(snap.calendar && withoutDeviceOnly(snap.calendar));
		member.holds?.({ snap, file: { profile, timeline, calendar }, ctx });
	} finally {
		for (const record of toWipe) zeroizeRecord(record);
	}
}

describe('every record the public setters can write validates and round-trips under every clock', () => {
	describe.each(CLOCKS)('$name', (clock) => {
		it.each(MEMBERS)(
			'$name',
			async (member) => {
				const db = await openTestDb();
				let ctx: Ctx | undefined;
				try {
					ctx = await finishedDevice(db, clock);
					await member.run(ctx);
					await exportAndReadBack(db, ctx, member);
				} finally {
					// The store holds the profile's date bytes; a screen that is done with them wipes them the same way.
					ctx?.profile.relockSync('hygiene');
					vi.useRealTimers();
					await deleteTestDb(db);
				}
			},
			120_000
		);
	});

	// The setter itself refuses these, so the corpus can never hold a record the file would refuse.
	describe('the setter refuses what a file cannot hold', () => {
		const refusals = [
			{
				name: 'a note on the SkillBridge plan key',
				key: SKILLBRIDGE_PLAN_KEY,
				note: 'x',
				code: 'E_NOTE_KEY'
			},
			{
				name: `a note of ${MAX_NOTE_UNITS + 1} units`,
				key: 'job-search',
				note: 'n'.repeat(MAX_NOTE_UNITS + 1),
				code: 'E_NOTE_TOO_LONG'
			}
		];
		it.each(refusals)(
			'$name: the setter rejects and the saved record is untouched',
			async ({ key, note, code }) => {
				const db = await openTestDb();
				let ctx: Ctx | undefined;
				try {
					ctx = await finishedDevice(db, CLOCKS[0] as Clock);
					await ctx.timeline.setNote('va-gov-account', 'kept');
					await expect(ctx.timeline.setNote(key, note)).rejects.toThrow(code);
					await exportAndReadBack(db, ctx, {
						name: 'after the refusal',
						run: () => Promise.resolve(),
						holds: (seen) =>
							expect(seen.snap.timeline?.tasks).toStrictEqual({
								'va-gov-account': { notes: 'kept' }
							})
					});
				} finally {
					ctx?.profile.relockSync('hygiene');
					await deleteTestDb(db);
				}
			}
		);
	});
});
