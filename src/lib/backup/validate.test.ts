import { describe, expect, it, vi } from 'vitest';
import { decodeCalendarSyncState } from '../calendar/codec';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { decodeProfile, encodeProfile } from '../profile/codec';
import { decodeTimelineState } from '../timeline/state-codec';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { SKILLBRIDGE_PLAN_KEY } from '../timeline/skillbridge-plan';
import { BACKUP_RELEASE_DATE } from './dates';
import { MAX_NOTE_UNITS } from './note-cap';
import { validateInner } from './validate';

type Bag = Record<string, unknown>;
type Store = 'profile' | 'timeline' | 'calendar';

// One good file as the real app writes it, in pieces the cases below edit one at a time. The profile comes from the
// shipped encoder, so its wire keys and base64 are the app's own.
type Parts = {
	inner: Bag;
	stores: Bag;
	profile: Bag;
	timeline: Bag;
	tasks: Record<string, Bag>;
	calendar: Bag;
	exclusions: Bag;
	card: Bag;
};

const NOW = 1_760_000_000_000;
const date = (iso: string) => encodeEaos(parseEaosAtRead(iso));

function goodParts(): Parts {
	const profile = JSON.parse(
		new TextDecoder().decode(
			encodeProfile({
				schemaVersion: 1,
				generation: 7,
				lastSeenAt: NOW,
				setupIntent: 'completed',
				setupIntentChangedAt: NOW - 86_400_000,
				eaos: date('2027-06-30'),
				skillbridgeStart: date('2027-03-01'),
				terminalLeaveStart: date('2027-05-01')
			})
		)
	) as Bag;
	const tasks: Record<string, Bag> = {
		'va-gov-account': { status: 'done' },
		'tap-course': { status: 'snoozed', snoozeUntil: '2027-01-15', notes: 'Call the TAP office' },
		'will-poa': { notes: 'Ask legal' },
		'job-search': { status: 'skipped' },
		[SKILLBRIDGE_PLAN_KEY]: { status: 'snoozed' }
	};
	const timeline: Bag = { schemaVersion: 1, tasks };
	const exclusions: Bag = { taskIds: ['job-search'], categories: ['finance', 'medical'] };
	const card: Bag = { dismissedAt: NOW, dismissCount: 2 };
	const calendar: Bag = { schemaVersion: 1, exclusions, card };
	const stores: Bag = { profile, 'timeline-state': timeline, 'calendar-sync': calendar };
	const inner: Bag = { appVersion: __APP_VERSION__, backupSchema: 1, createdAt: NOW, stores };
	return { inner, stores, profile, timeline, tasks, calendar, exclusions, card };
}

/** The file as JSON.parse hands it over: no shared objects, no undefined values. */
function make(edit: (p: Parts) => void = () => {}): unknown {
	const parts = goodParts();
	edit(parts);
	return JSON.parse(JSON.stringify(parts.inner));
}

/** The good file's JSON text, edited as text: the only way to get an own `__proto__` key. */
function makeFromText(edit: (text: string) => string): unknown {
	return JSON.parse(edit(JSON.stringify(goodParts().inner)));
}

const refusal = (
	store?: Store,
	code: 'E_CONTENT_INVALID' | 'E_NEWER_VERSION' = 'E_CONTENT_INVALID'
) => ({ ok: false, code, ...(store && { store }) }) as const;

const utf8 = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** Every store of an accepted file, read back by the shipped decoders. */
function expectDecodersAgree(inner: Bag) {
	const stores = inner.stores as Bag;
	const profile = decodeProfile(utf8(stores.profile));
	expect(JSON.parse(new TextDecoder().decode(encodeProfile(profile)))).toEqual(stores.profile);
	if (stores['timeline-state'] !== null) {
		expect(decodeTimelineState(utf8(stores['timeline-state']))).toEqual(stores['timeline-state']);
	}
	if (stores['calendar-sync'] !== null) {
		expect(decodeCalendarSyncState(utf8(stores['calendar-sync']))).toEqual(stores['calendar-sync']);
	}
	// The dates in the profile are the ones the Settings read check accepts.
	expect(decodeEaos(profile.eaos ?? new Uint8Array())).toBe('2027-06-30');
}

describe('validateInner: a good file', () => {
	it('good file validates and round-trips', () => {
		const file = make();
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.inner).toEqual(file);
		expectDecodersAgree(result.inner as unknown as Bag);
	});

	// A person can exclude a task and later start a backup on a device that never saved a timeline: both records
	// are legitimately absent, and the writer turns an absent record into an empty one.
	it.each(['timeline-state', 'calendar-sync'] as const)(
		'%s null validates (no record yet)',
		(key) => {
			const file = make((p) => {
				p.stores[key] = null;
			});
			const result = validateInner(file);
			expect(result.ok).toBe(true);
			if (result.ok) expect((result.inner.stores as Bag)[key]).toBeNull();
		}
	);
});

describe('validateInner: acceptance corpus (shapes the app writes)', () => {
	const RTL = String.fromCharCode(0x5e9, 0x5dc, 0x5d5, 0x5dd, 0x20, 0x627, 0x644, 0x633);
	const EMOJI = String.fromCharCode(0xd83d, 0xde80, 0x20, 0xe9, 0x20, 0x4e2d);
	const cases: [string, (p: Parts) => void][] = [
		[
			'unicode, emoji and right-to-left notes',
			(p) => {
				p.tasks['will-poa'] = { notes: RTL + ' ' + EMOJI };
			}
		],
		[
			'a note of exactly the cap',
			(p) => {
				p.tasks['will-poa'] = { notes: 'a'.repeat(MAX_NOTE_UNITS) };
			}
		],
		[
			'every known task id with a status',
			(p) => {
				p.timeline.tasks = Object.fromEntries(KNOWN_TASK_IDS.map((id) => [id, { status: 'done' }]));
			}
		],
		[
			'a snoozed task with no date',
			(p) => {
				p.tasks['tap-course'] = { status: 'snoozed' };
			}
		],
		[
			'the plan key snoozed to a date',
			(p) => {
				p.tasks[SKILLBRIDGE_PLAN_KEY] = { status: 'snoozed', snoozeUntil: '2026-12-01' };
			}
		],
		[
			'the plan key done',
			(p) => {
				p.tasks[SKILLBRIDGE_PLAN_KEY] = { status: 'done' };
			}
		],
		[
			'an empty task list',
			(p) => {
				p.timeline.tasks = {};
			}
		],
		[
			'a whitespace-only note',
			(p) => {
				p.tasks['will-poa'] = { notes: '   ' };
				p.tasks['tap-course'] = { notes: '\n' };
			}
		],
		[
			'a calendar without a card',
			(p) => {
				delete p.calendar.card;
			}
		],
		[
			'a calendar that excludes nothing',
			(p) => {
				p.calendar.exclusions = { taskIds: [], categories: [] };
			}
		],
		[
			'a card never dismissed twice',
			(p) => {
				p.calendar.card = { dismissedAt: 0, dismissCount: 0 };
			}
		],
		[
			'createdAt 0',
			(p) => {
				p.inner.createdAt = 0;
			}
		],
		[
			'createdAt 8.64e15',
			(p) => {
				p.inner.createdAt = 8.64e15;
			}
		],
		[
			'createdAt before the release date',
			(p) => {
				p.inner.createdAt = BACKUP_RELEASE_DATE - 1;
			}
		],
		[
			'a profile with only the separation date',
			(p) => {
				delete p.profile.skillbridgeStart;
				delete p.profile.terminalLeaveStart;
			}
		],
		[
			'a profile with no change time yet',
			(p) => {
				p.profile.setupIntentChangedAt = null;
			}
		],
		[
			'a time ahead of the clock',
			(p) => {
				p.profile.lastSeenAt = 8.64e15;
				p.calendar.card = { dismissedAt: 8.64e15, dismissCount: 10_000 };
			}
		]
	];

	it.each(cases)('%s', (_name, edit) => {
		const file = make(edit);
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.inner).toEqual(file);
		expectDecodersAgree(result.inner as unknown as Bag);
	});

	// A file from a newer app that kept every shape this app knows still opens: NEWER_VERSION is for a refusal only.
	it('a newer appVersion on a file that passes is accepted', () => {
		const result = validateInner(make((p) => (p.inner.appVersion = '999.0.0')));
		expect(result.ok).toBe(true);
	});
});

describe('validateInner: refusal corpus (one change to a good file each)', () => {
	const NEVER_WRITTEN = [
		'rate',
		'rank',
		'yearsOfService',
		'anticipatedDisabilityRating',
		'familyStatus',
		'intendedPath',
		'geographicDestination',
		'specialSituations'
	];
	const BACKUP_MARK = [
		'lastBackupAt',
		'backupGenProfile',
		'backupGenTimeline',
		'backupGenCalendar'
	];
	const b64 = (s: string) => btoa(s);

	const cases: [string, (p: Parts) => void, Store?][] = [
		// The file as a whole.
		['an extra key in the inner object', (p) => (p.inner.extra = 1)],
		['an extra key in stores', (p) => (p.stores.extra = null)],
		['a missing createdAt', (p) => delete p.inner.createdAt],
		['a missing stores key', (p) => delete p.stores['calendar-sync']],
		['stores as an array', (p) => (p.inner.stores = [])],
		['stores as null', (p) => (p.inner.stores = null)],
		['createdAt 8.64e15 + 1', (p) => (p.inner.createdAt = 8.64e15 + 1)],
		['createdAt 1e20', (p) => (p.inner.createdAt = 1e20)],
		['createdAt -1', (p) => (p.inner.createdAt = -1)],
		['createdAt 1.5', (p) => (p.inner.createdAt = 1.5)],
		["createdAt '1'", (p) => (p.inner.createdAt = '1')],
		['createdAt as an array', (p) => (p.inner.createdAt = [1])],
		// The profile.
		['profile as null', (p) => (p.stores.profile = null), 'profile'],
		['profile as an array', (p) => (p.stores.profile = []), 'profile'],
		['an extra key in the profile', (p) => (p.profile.extra = 1), 'profile'],
		['a missing generation', (p) => delete p.profile.generation, 'profile'],
		['a missing eaos', (p) => delete p.profile.eaos, 'profile'],
		['a missing setupIntentChangedAt', (p) => delete p.profile.setupIntentChangedAt, 'profile'],
		["generation as '7'", (p) => (p.profile.generation = '7'), 'profile'],
		['generation 0', (p) => (p.profile.generation = 0), 'profile'],
		['generation 1.5', (p) => (p.profile.generation = 1.5), 'profile'],
		['lastSeenAt as an array', (p) => (p.profile.lastSeenAt = [NOW]), 'profile'],
		['lastSeenAt 8.64e15 + 1', (p) => (p.profile.lastSeenAt = 8.64e15 + 1), 'profile'],
		["setupIntentChangedAt as '1'", (p) => (p.profile.setupIntentChangedAt = '1'), 'profile'],
		['setupIntentChangedAt -1', (p) => (p.profile.setupIntentChangedAt = -1), 'profile'],
		["setupIntent 'pending'", (p) => (p.profile.setupIntent = 'pending'), 'profile'],
		['schemaVersion 2 in the profile', (p) => (p.profile.schemaVersion = 2), 'profile'],
		['eaos null', (p) => (p.profile.eaos = null), 'profile'],
		['eaos as a number', (p) => (p.profile.eaos = 20270630), 'profile'],
		['eaos as an object', (p) => (p.profile.eaos = {}), 'profile'],
		['eaos empty', (p) => (p.profile.eaos = ''), 'profile'],
		['eaos without padding', (p) => (p.profile.eaos = 'MjAyNy0wNi0zMA'), 'profile'],
		['eaos with a space in it', (p) => (p.profile.eaos = 'MjAy Ny0wNi0zMA=='), 'profile'],
		['eaos with a newline in it', (p) => (p.profile.eaos = 'MjAyNy0wNi0z\nMA=='), 'profile'],
		['eaos in the URL-safe alphabet', (p) => (p.profile.eaos = '-jAyNy0wNi0zMA=='), 'profile'],
		// The shipped decoder reads this as the same date as 'MA==' but writes it back as 'MA==': the round trip refuses it.
		[
			'eaos with spare bits set in its last group',
			(p) => (p.profile.eaos = 'MjAyNy0wNi0zMB=='),
			'profile'
		],
		[
			'eaos that decodes to an impossible day',
			(p) => (p.profile.eaos = b64('2027-02-30')),
			'profile'
		],
		[
			'eaos that decodes to text that is no date',
			(p) => (p.profile.eaos = b64('not a date')),
			'profile'
		],
		[
			'eaos that decodes to a date with a short month',
			(p) => (p.profile.eaos = b64('2027-6-30')),
			'profile'
		],
		['skillbridgeStart as a number', (p) => (p.profile.skillbridgeStart = 5), 'profile'],
		['skillbridgeStart empty', (p) => (p.profile.skillbridgeStart = ''), 'profile'],
		['skillbridgeStart not base64', (p) => (p.profile.skillbridgeStart = '2027-03-01'), 'profile'],
		[
			'skillbridgeStart that decodes to no date',
			(p) => (p.profile.skillbridgeStart = b64('soon')),
			'profile'
		],
		['terminalLeaveStart as null', (p) => (p.profile.terminalLeaveStart = null), 'profile'],
		[
			'terminalLeaveStart that decodes to year 1800',
			(p) => (p.profile.terminalLeaveStart = b64('1800-05-01')),
			'profile'
		],
		...NEVER_WRITTEN.map((key): [string, (p: Parts) => void, Store] => [
			`the never-written profile field ${key}`,
			(p) => (p.profile[key] = b64('x')),
			'profile'
		]),
		...BACKUP_MARK.map((key): [string, (p: Parts) => void, Store] => [
			`the backup mark ${key} in the profile`,
			(p) => (p.profile[key] = 1),
			'profile'
		]),
		// The timeline.
		['an extra key in the timeline', (p) => (p.timeline.extra = 1), 'timeline'],
		['a missing tasks', (p) => delete p.timeline.tasks, 'timeline'],
		['timeline schemaVersion 2', (p) => (p.timeline.schemaVersion = 2), 'timeline'],
		["timeline schemaVersion '1'", (p) => (p.timeline.schemaVersion = '1'), 'timeline'],
		['tasks as an array', (p) => (p.timeline.tasks = []), 'timeline'],
		['tasks as a string', (p) => (p.timeline.tasks = 'none'), 'timeline'],
		['a timeline that is an array', (p) => (p.stores['timeline-state'] = []), 'timeline'],
		[
			'an extra key in a task',
			(p) => (p.tasks['va-gov-account'] = { status: 'done', extra: 1 }),
			'timeline'
		],
		['an unknown task id', (p) => (p.tasks['not-a-task'] = { status: 'done' }), 'timeline'],
		['a task as an array', (p) => (p.tasks['va-gov-account'] = [] as unknown as Bag), 'timeline'],
		['a task as null', (p) => (p.tasks['va-gov-account'] = null as unknown as Bag), 'timeline'],
		['a task with nothing in it', (p) => (p.tasks['va-gov-account'] = {}), 'timeline'],
		['status later', (p) => (p.tasks['va-gov-account'] = { status: 'later' }), 'timeline'],
		['status as a number', (p) => (p.tasks['va-gov-account'] = { status: 1 }), 'timeline'],
		[
			'snoozeUntil with status done',
			(p) => (p.tasks['va-gov-account'] = { status: 'done', snoozeUntil: '2027-01-15' }),
			'timeline'
		],
		[
			'snoozeUntil with no status',
			(p) => (p.tasks['va-gov-account'] = { snoozeUntil: '2027-01-15' }),
			'timeline'
		],
		[
			'snoozeUntil that is no day',
			(p) => (p.tasks['tap-course'] = { status: 'snoozed', snoozeUntil: '2027-02-30' }),
			'timeline'
		],
		[
			'snoozeUntil after the last day a snooze can name',
			(p) => (p.tasks['tap-course'] = { status: 'snoozed', snoozeUntil: '9999-12-31' }),
			'timeline'
		],
		[
			'snoozeUntil as a number',
			(p) => (p.tasks['tap-course'] = { status: 'snoozed', snoozeUntil: 20270115 }),
			'timeline'
		],
		[
			'a note of 100,001 units',
			(p) => (p.tasks['will-poa'] = { notes: 'a'.repeat(MAX_NOTE_UNITS + 1) }),
			'timeline'
		],
		['an empty note', (p) => (p.tasks['will-poa'] = { notes: '' }), 'timeline'],
		['a note as a number', (p) => (p.tasks['will-poa'] = { notes: 5 }), 'timeline'],
		['a note as an array', (p) => (p.tasks['will-poa'] = { notes: ['a'] }), 'timeline'],
		[
			'a note on the plan key',
			(p) => (p.tasks[SKILLBRIDGE_PLAN_KEY] = { status: 'snoozed', notes: 'hello' }),
			'timeline'
		],
		[
			'an extra key on the plan key',
			(p) => (p.tasks[SKILLBRIDGE_PLAN_KEY] = { status: 'done', extra: 1 }),
			'timeline'
		],
		[
			'snoozeUntil alone on the plan key',
			(p) => (p.tasks[SKILLBRIDGE_PLAN_KEY] = { snoozeUntil: '2027-01-15' }),
			'timeline'
		],
		[
			'1,001 tasks',
			(p) => {
				for (let i = 0; i <= 1000; i += 1) p.tasks[`task-${i}`] = { status: 'done' };
			},
			'timeline'
		],
		// The calendar.
		['calendar as an array', (p) => (p.stores['calendar-sync'] = []), 'calendar'],
		['an extra key in the calendar', (p) => (p.calendar.extra = 1), 'calendar'],
		['a missing exclusions', (p) => delete p.calendar.exclusions, 'calendar'],
		['calendar schemaVersion 2', (p) => (p.calendar.schemaVersion = 2), 'calendar'],
		['an extra key in exclusions', (p) => (p.exclusions.extra = []), 'calendar'],
		['a missing categories', (p) => delete p.exclusions.categories, 'calendar'],
		['exclusions as an array', (p) => (p.calendar.exclusions = []), 'calendar'],
		['taskIds as an object', (p) => (p.exclusions.taskIds = {}), 'calendar'],
		['categories as a string', (p) => (p.exclusions.categories = 'finance'), 'calendar'],
		['a taskId as a number', (p) => (p.exclusions.taskIds = [1]), 'calendar'],
		[
			'a duplicate task id',
			(p) => (p.exclusions.taskIds = ['job-search', 'job-search']),
			'calendar'
		],
		[
			'an unknown task id in the calendar',
			(p) => (p.exclusions.taskIds = ['not-a-task']),
			'calendar'
		],
		['a duplicate category', (p) => (p.exclusions.categories = ['finance', 'finance']), 'calendar'],
		['an unknown category', (p) => (p.exclusions.categories = ['sports']), 'calendar'],
		[
			'1,001 categories',
			(p) => (p.exclusions.categories = Array.from({ length: 1001 }, () => 'finance')),
			'calendar'
		],
		['lastAdd present', (p) => (p.calendar.lastAdd = []), 'calendar'],
		['an extra key in the card', (p) => (p.card.extra = 1), 'calendar'],
		['a card as an array', (p) => (p.calendar.card = []), 'calendar'],
		['a card as null', (p) => (p.calendar.card = null), 'calendar'],
		['a card with no dismissCount', (p) => delete p.card.dismissCount, 'calendar'],
		['a card with no dismissedAt', (p) => delete p.card.dismissedAt, 'calendar'],
		['dismissCount 10,001', (p) => (p.card.dismissCount = 10_001), 'calendar'],
		['dismissCount 1.5', (p) => (p.card.dismissCount = 1.5), 'calendar'],
		['dismissCount -1', (p) => (p.card.dismissCount = -1), 'calendar'],
		["dismissedAt '1'", (p) => (p.card.dismissedAt = '1'), 'calendar'],
		['dismissedAt 8.64e15 + 1', (p) => (p.card.dismissedAt = 8.64e15 + 1), 'calendar']
	];

	it.each(cases)('%s', (_name, edit, store) => {
		expect(validateInner(make(edit))).toEqual(refusal(store));
	});

	// JSON.parse gives an own `__proto__` key; object assignment would set the prototype instead, so it is built as text.
	it.each([
		['the inner object', '{', '{"__proto__":{},', undefined],
		['stores', '"stores":{', '"stores":{"__proto__":{},', undefined],
		['the profile', '"profile":{', '"profile":{"__proto__":{},', 'profile'],
		['the tasks', '"tasks":{', '"tasks":{"__proto__":{"status":"done"},', 'timeline'],
		['a task', '"va-gov-account":{', '"va-gov-account":{"__proto__":{},', 'timeline'],
		['exclusions', '"exclusions":{', '"exclusions":{"__proto__":[],', 'calendar'],
		['the card', '"card":{', '"card":{"__proto__":{},', 'calendar']
	] as const)('an own __proto__ key in %s', (_name, anchor, inserted, store) => {
		const file = makeFromText((text) => text.replace(anchor, inserted));
		expect(validateInner(file)).toEqual(refusal(store));
	});

	it.each([
		['null', null],
		['an array', []],
		['a string', 'backup'],
		['a number', 1],
		['an empty object', {}]
	])('a file that is %s', (_name, value) => {
		expect(validateInner(value)).toEqual(refusal());
	});
});

describe('validateInner: versions', () => {
	const MAJOR_MINOR_PATCH = __APP_VERSION__.split('.').map(Number) as [number, number, number];
	const oneMinorAhead = `${MAJOR_MINOR_PATCH[0]}.${MAJOR_MINOR_PATCH[1] + 1}.0`;

	it('backupSchema 2 is NEWER_VERSION and checked before anything else', () => {
		const file = { backupSchema: 2, appVersion: 5, createdAt: 'x', stores: [], extra: true };
		expect(validateInner(file)).toEqual(refusal(undefined, 'E_NEWER_VERSION'));
	});

	it.each([
		['0', 0],
		['1.5', 1.5],
		['"1"', '1'],
		['-1', -1],
		['null', null],
		['an array', [1]],
		['missing', undefined]
	])('backupSchema %s is CONTENT_INVALID', (_name, schema) => {
		const file = make((p) => {
			if (schema === undefined) delete p.inner.backupSchema;
			else p.inner.backupSchema = schema;
		});
		expect(validateInner(file)).toEqual(refusal());
	});

	it('appVersion one minor ahead with an unknown field is NEWER_VERSION', () => {
		const file = make((p) => {
			p.inner.appVersion = oneMinorAhead;
			p.profile.extra = 1;
		});
		expect(validateInner(file)).toEqual(refusal(undefined, 'E_NEWER_VERSION'));
	});

	it('appVersion equal with an unknown field is CONTENT_INVALID', () => {
		const file = make((p) => (p.profile.extra = 1));
		expect(validateInner(file)).toEqual(refusal('profile'));
	});

	it('appVersion older with an unknown field is CONTENT_INVALID', () => {
		const file = make((p) => {
			p.inner.appVersion = '0.0.1';
			p.tasks['not-a-task'] = { status: 'done' };
		});
		expect(validateInner(file)).toEqual(refusal('timeline'));
	});

	it('a newer file whose content is wrong in the inner object itself is NEWER_VERSION', () => {
		const file = make((p) => {
			p.inner.appVersion = oneMinorAhead;
			p.inner.extra = 1;
		});
		expect(validateInner(file)).toEqual(refusal(undefined, 'E_NEWER_VERSION'));
	});

	it.each([
		['1.2', '1.2'],
		['01.2.3', '01.2.3'],
		['21 characters', '123456.123456.1234567'],
		['a number', 1.2],
		['null', null],
		['missing', undefined]
	])('a malformed appVersion (%s) is CONTENT_INVALID', (_name, version) => {
		const file = make((p) => {
			if (version === undefined) delete p.inner.appVersion;
			else p.inner.appVersion = version;
		});
		expect(validateInner(file)).toEqual(refusal());
	});
});

describe('validateInner: hostile input', () => {
	// A task value is the deepest place a file can nest, and the validator reads it as a task before entering it.
	it('a 100,000-deep nested array in a task value is CONTENT_INVALID and does not throw', () => {
		const deep = (): unknown => {
			let value: unknown = [];
			for (let i = 0; i < 100_000; i += 1) value = [value];
			return value;
		};
		for (const place of ['task', 'status', 'notes', 'snoozeUntil'] as const) {
			const file = make();
			const tasks = ((file as Bag).stores as Bag)['timeline-state'] as Bag;
			(tasks.tasks as Bag)['va-gov-account'] = place === 'task' ? deep() : { [place]: deep() };
			let result: ReturnType<typeof validateInner> | undefined;
			expect(() => {
				result = validateInner(file);
			}).not.toThrow();
			expect(result).toEqual(refusal('timeline'));
		}
	});

	it('a 100,000-deep nested array at the top of a store is CONTENT_INVALID and does not throw', () => {
		let value: unknown = [];
		for (let i = 0; i < 100_000; i += 1) value = [value];
		const file = make();
		(((file as Bag).stores as Bag)['calendar-sync'] as Bag).exclusions = value;
		expect(validateInner(file)).toEqual(refusal('calendar'));
	});

	it('no validator rule reads Date.now', () => {
		const clock = vi.spyOn(Date, 'now');
		try {
			validateInner(make());
			validateInner(make((p) => (p.inner.createdAt = 0)));
			validateInner(make((p) => (p.profile.extra = 1)));
			expect(clock).not.toHaveBeenCalled();
		} finally {
			clock.mockRestore();
		}
	});

	// The caller keeps decrypting into the same buffers; nothing it hands over may be the object it later changes.
	it('the result is built fresh', () => {
		const file = make() as Bag;
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const before = structuredClone(result.inner);
		const stores = file.stores as Bag;
		expect(result.inner).not.toBe(file);
		expect(result.inner.stores).not.toBe(stores);
		expect(result.inner.stores.profile).not.toBe(stores.profile);
		expect(result.inner.stores['timeline-state']).not.toBe(stores['timeline-state']);
		expect(result.inner.stores['calendar-sync']).not.toBe(stores['calendar-sync']);
		(stores.profile as Bag).generation = 99;
		((stores['timeline-state'] as Bag).tasks as Record<string, Bag>)['va-gov-account']!.status =
			'skipped';
		(((stores['calendar-sync'] as Bag).exclusions as Bag).taskIds as string[]).push('tap-course');
		(file as Bag).extra = true;
		expect(result.inner).toEqual(before);
	});
});
