import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeCalendarSyncState } from '../calendar/codec';
import { decodeEaos, encodeEaos, parseEaosAtRead } from '../profile/eaos';
import { decodeProfile, encodeProfile } from '../profile/codec';
import { BRANCHES, DURATIONS, INDUSTRIES, KINDS } from '../skillbridge-finder/contract/listing';
import { CLEAN_CASES, cleanListing } from '../skillbridge-finder/fixtures/clean';
import { decodeFinderRecord } from '../skillbridge-finder/state/codec';
import { MAX_COMPARE, MAX_SAVED } from '../skillbridge-finder/state/types';
import { decodeTimelineState } from '../timeline/state-codec';
import { KNOWN_TASK_IDS } from '../timeline/known-task-ids';
import { SKILLBRIDGE_PLAN_KEY } from '../timeline/skillbridge-plan';
import { BACKUP_RELEASE_DATE } from './dates';
import { MAX_NOTE_UNITS } from './note-cap';
import { validateInner } from './validate';

// The real wipe, with the record it was given kept so a test can look at it afterwards.
const wiped = vi.hoisted(() => ({ records: [] as Record<string, unknown>[] }));
vi.mock('../profile/lifecycle', async (importOriginal) => {
	const real = await importOriginal<typeof import('../profile/lifecycle')>();
	return {
		...real,
		zeroizeRecord: (record: Record<string, unknown>) => {
			wiped.records.push(record);
			real.zeroizeRecord(record);
		}
	};
});

// The finder's record decoder, a passthrough until a test arms it. The validator checks every rule itself and then asks
// this decoder to read its answer back as a net; a lenient decoder (it hands back whatever it was given) shows each
// rule of the validator refuses on its own, and one that throws shows the net is really cast. It keeps each buffer it
// was handed, so a test can look at them once the validator has returned.
const finderCodec = vi.hoisted(() => ({
	mode: 'real' as 'real' | 'lenient' | 'throws',
	seen: [] as Uint8Array[]
}));
vi.mock('../skillbridge-finder/state/codec', async (importOriginal) => {
	const real = await importOriginal<typeof import('../skillbridge-finder/state/codec')>();
	return {
		...real,
		decodeFinderRecord: (bytes: Uint8Array) => {
			finderCodec.seen.push(bytes);
			if (finderCodec.mode === 'throws') throw new Error('E_TEST_CODEC_THROWS');
			if (finderCodec.mode === 'lenient')
				return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
			return real.decodeFinderRecord(bytes);
		}
	};
});

type Bag = Record<string, unknown>;
type Store = 'profile' | 'timeline' | 'calendar' | 'finder';

// One good file as the real app writes it, in pieces the cases below edit one at a time. The profile comes from the
// shipped encoder, so its wire keys and base64 are the app's own. `finder` is a good finder record that is NOT in the
// file until a case puts it there: a file made before the finder existed has no such key.
type Parts = {
	inner: Bag;
	stores: Bag;
	profile: Bag;
	timeline: Bag;
	tasks: Record<string, Bag>;
	calendar: Bag;
	exclusions: Bag;
	card: Bag;
	finder: Bag;
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
	const finder: Bag = {
		schemaVersion: 1,
		finderSetup: {
			place: { kind: 'zip', zip: '21046' },
			radius: 50,
			territories: true,
			overseas: false
		},
		finderFilters: {
			industries: ['Healthcare Support', 'Legal'],
			branches: ['Army', 'Navy'],
			durations: ['91-120'],
			kinds: ['internship', 'fellowship'],
			delivery: [1, 3]
		},
		finderSaved: [
			{ id: 1001, savedOn: '2026-10-21', facts: cleanListing() },
			{ id: 1013, savedOn: '2026-10-20', facts: CLEAN_CASES.multiState }
		],
		finderCompare: [1001, 1013]
	};
	return { inner, stores, profile, timeline, tasks, calendar, exclusions, card, finder };
}

/** Puts the good finder record into the file, then lets the case edit it. */
const withFinder =
	(edit: (finder: Bag, p: Parts) => void = () => {}) =>
	(p: Parts) => {
		p.stores['skillbridge-finder'] = p.finder;
		edit(p.finder, p);
	};

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
	if (stores['skillbridge-finder'] !== undefined) {
		expect(decodeFinderRecord(utf8(stores['skillbridge-finder']))).toEqual(
			stores['skillbridge-finder']
		);
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

// A backup made before the finder existed holds no finder key and must still restore; one made after holds the person's
// answers, saved programs and compare picks.
describe('validateInner: the finder record', () => {
	it('a file made before the finder existed validates, with no finder key in the result', () => {
		const result = validateInner(make());
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.inner.stores).not.toHaveProperty('skillbridge-finder');
	});

	it('a file with a finder record validates, round-trips and is read back by the shipped decoder', () => {
		const file = make(withFinder());
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.inner).toEqual(file);
		expectDecodersAgree(result.inner as unknown as Bag);
	});

	const EVERY = <T extends string>(all: readonly T[]) => [...all];
	const accepted: [string, (f: Bag) => void][] = [
		[
			'nothing saved and no answers',
			(f) => {
				delete f.finderSetup;
				delete f.finderFilters;
				f.finderSaved = [];
				f.finderCompare = [];
			}
		],
		[
			'an empty setup and empty filters',
			(f) => {
				f.finderSetup = {};
				f.finderFilters = {};
			}
		],
		[
			'a state as the place',
			(f) => ((f.finderSetup as Bag).place = { kind: 'state', state: 'TX' })
		],
		[
			'a territory as the place',
			(f) => ((f.finderSetup as Bag).place = { kind: 'state', state: 'PR' })
		],
		['reach set to any', (f) => ((f.finderSetup as Bag).radius = 'any')],
		[
			'every industry, branch, duration and kind picked',
			(f) => {
				f.finderFilters = {
					industries: EVERY(INDUSTRIES),
					branches: EVERY(BRANCHES),
					durations: EVERY(DURATIONS),
					kinds: EVERY(KINDS),
					delivery: [1, 2, 3]
				};
			}
		],
		[
			'a program with no place, a remote program and a territory program, saved',
			(f) => {
				f.finderSaved = [
					CLEAN_CASES.locationUnknown,
					CLEAN_CASES.remote,
					CLEAN_CASES.territory
				].map((facts) => ({ id: facts.i, savedOn: '2026-10-21', facts }));
				f.finderCompare = [];
			}
		],
		[
			'the most programs that can be saved',
			(f) => {
				f.finderSaved = Array.from({ length: MAX_SAVED }, (_, n) => ({
					id: n + 1,
					savedOn: '2026-10-21',
					facts: cleanListing({ i: n + 1 })
				}));
				f.finderCompare = Array.from({ length: MAX_COMPARE }, (_, n) => n + 1);
			}
		]
	];
	it.each(accepted)('accepts %s', (_name, edit) => {
		const file = make(withFinder(edit));
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.inner).toEqual(file);
		expectDecodersAgree(result.inner as unknown as Bag);
	});

	it('the finder record in the result is built fresh, down to a saved program', () => {
		const file = make(withFinder()) as Bag;
		const result = validateInner(file);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const mine = result.inner.stores['skillbridge-finder'];
		const theirs = (file.stores as Bag)['skillbridge-finder'] as Bag;
		const before = structuredClone(mine);
		expect(mine).not.toBe(theirs);
		expect(mine?.finderSaved[0]?.facts).not.toBe((theirs.finderSaved as Bag[])[0]?.facts);
		(((theirs.finderSaved as Bag[])[0] as Bag).facts as Bag).n = 'Changed';
		(theirs.finderCompare as number[]).push(5);
		expect(mine).toEqual(before);
	});
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
			'a profile with a ZIP as where they plan to live',
			(p) => {
				p.profile.geographicDestination = btoa('21046');
			}
		],
		[
			'a profile with a state as where they plan to live',
			(p) => {
				p.profile.geographicDestination = btoa('Maryland');
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

/** One bad value per rule of the finder record, at each level: the record, setup, place, filters, a saved program, compare. */
function finderCases(): [string, (p: Parts) => void, Store][] {
	const setup = (f: Bag) => f.finderSetup as Bag;
	const filters = (f: Bag) => f.finderFilters as Bag;
	const saved = (f: Bag) => f.finderSaved as Bag[];
	const first = (f: Bag) => saved(f)[0] as Bag;
	const facts = (f: Bag) => first(f).facts as Bag;
	const list: [string, (f: Bag) => void][] = [
		['an extra key in the finder record', (f) => (f.extra = 1)],
		['finder schemaVersion 2', (f) => (f.schemaVersion = 2)],
		['a finder record with no saved list', (f) => delete f.finderSaved],
		['a finder record with no compare list', (f) => delete f.finderCompare],
		// The setup.
		['setup as null', (f) => (f.finderSetup = null)],
		['an extra key in the setup', (f) => (setup(f).extra = 1)],
		['a place as null', (f) => (setup(f).place = null)],
		[
			'an extra key in a zip place',
			(f) => (setup(f).place = { kind: 'zip', zip: '21046', extra: 1 })
		],
		[
			'an installation as the place',
			(f) => (setup(f).place = { kind: 'installation', id: 'fort-meade' })
		],
		['a place with an unknown kind', (f) => (setup(f).place = { kind: 'city', city: 'Columbia' })],
		['a zip place holding a state', (f) => (setup(f).place = { kind: 'zip', state: 'MD' })],
		['a zip of four digits', (f) => (setup(f).place = { kind: 'zip', zip: '2104' })],
		['a zip as a number', (f) => (setup(f).place = { kind: 'zip', zip: 21046 })],
		['a zip with a trailing space', (f) => (setup(f).place = { kind: 'zip', zip: '21046 ' })],
		['a state that is not one', (f) => (setup(f).place = { kind: 'state', state: 'ZZ' })],
		['a state in lower case', (f) => (setup(f).place = { kind: 'state', state: 'tx' })],
		['a state place holding a zip', (f) => (setup(f).place = { kind: 'state', zip: '21046' })],
		['a reach of 75', (f) => (setup(f).radius = 75)],
		['a reach given as text', (f) => (setup(f).radius = '25')],
		['territories as text', (f) => (setup(f).territories = 'yes')],
		['overseas as a number', (f) => (setup(f).overseas = 1)],
		// The filters.
		['filters as null', (f) => (f.finderFilters = null)],
		['an extra key in the filters', (f) => (filters(f).extra = [])],
		['an industry that is not listed', (f) => (filters(f).industries = ['Farming'])],
		['a branch twice', (f) => (filters(f).branches = ['Army', 'Army'])],
		['a branch that is not listed', (f) => (filters(f).branches = ['Navy Reserve'])],
		['a duration that is not listed', (f) => (filters(f).durations = ['1-29'])],
		['a kind that is not listed', (f) => (filters(f).kinds = ['volunteer'])],
		['a delivery of 4', (f) => (filters(f).delivery = [4])],
		['a delivery given as text', (f) => (filters(f).delivery = ['1'])],
		['a filter list that is an object', (f) => (filters(f).industries = {})],
		// A saved program.
		['saved as an object', (f) => (f.finderSaved = {})],
		['a saved item as null', (f) => (saved(f)[0] = null as unknown as Bag)],
		['an extra key in a saved item', (f) => (first(f).extra = 1)],
		['a saved item with no date', (f) => delete first(f).savedOn],
		['a saved item with no facts', (f) => delete first(f).facts],
		['a saved id of 0', (f) => ((first(f).id = 0), (facts(f).i = 0))],
		['a saved id as text', (f) => (first(f).id = '1001')],
		// One bad date and one bad listing: the rules for each are the contract's, tested there; this proves the call is made.
		['a saved date that is no day', (f) => (first(f).savedOn = '2026-02-30')],
		['facts of another id', (f) => (facts(f).i = 1002)],
		['facts as null', (f) => (first(f).facts = null)],
		['facts with a key the contract does not list', (f) => (facts(f).summary = 'Great program')],
		['the same program saved twice', (f) => saved(f).push(structuredClone(first(f)))],
		[
			'201 programs saved',
			(f) => {
				f.finderSaved = Array.from({ length: MAX_SAVED + 1 }, (_, n) => ({
					id: n + 1,
					savedOn: '2026-10-21',
					facts: cleanListing({ i: n + 1 })
				}));
				f.finderCompare = [];
			}
		],
		// Compare.
		['four programs to compare', (f) => (f.finderCompare = [1, 2, 3, 4])],
		['the same program picked twice', (f) => (f.finderCompare = [1001, 1001])],
		['a compare id as text', (f) => (f.finderCompare = ['1001'])],
		['a compare id of 0', (f) => (f.finderCompare = [0])],
		['compare as an object', (f) => (f.finderCompare = {})]
	];
	return list.map(([name, edit]) => [name, withFinder(edit), 'finder']);
}

describe('validateInner: refusal corpus (one change to a good file each)', () => {
	const NEVER_WRITTEN = [
		'rate',
		'rank',
		'yearsOfService',
		'anticipatedDisabilityRating',
		'familyStatus',
		'intendedPath',
		'specialSituations'
	];
	const BACKUP_MARK = [
		'lastBackupAt',
		'backupGenProfile',
		'backupGenTimeline',
		'backupGenCalendar',
		'backupGenFinder'
	];
	const b64 = (s: string) => btoa(s);

	const cases: [string, (p: Parts) => void, Store?][] = [
		// The file as a whole.
		['an extra key in the inner object', (p) => (p.inner.extra = 1)],
		// A crafted file that plants the person's API-key store: a backup never carries it, so the key set refuses it.
		['a byok row planted in stores', (p) => (p.stores.byok = null)],
		['a missing stores key', (p) => delete p.stores['calendar-sync']],
		['stores as null', (p) => (p.inner.stores = null)],
		['createdAt 8.64e15 + 1', (p) => (p.inner.createdAt = 8.64e15 + 1)],
		['createdAt 1e20', (p) => (p.inner.createdAt = 1e20)],
		['createdAt -1', (p) => (p.inner.createdAt = -1)],
		['createdAt 1.5', (p) => (p.inner.createdAt = 1.5)],
		["createdAt '1'", (p) => (p.inner.createdAt = '1')],
		// The profile.
		['profile as null', (p) => (p.stores.profile = null), 'profile'],
		['an extra key in the profile', (p) => (p.profile.extra = 1), 'profile'],
		['a missing setupIntentChangedAt', (p) => delete p.profile.setupIntentChangedAt, 'profile'],
		["generation as '7'", (p) => (p.profile.generation = '7'), 'profile'],
		['generation 0', (p) => (p.profile.generation = 0), 'profile'],
		['generation 1.5', (p) => (p.profile.generation = 1.5), 'profile'],
		['lastSeenAt 8.64e15 + 1', (p) => (p.profile.lastSeenAt = 8.64e15 + 1), 'profile'],
		["setupIntentChangedAt as '1'", (p) => (p.profile.setupIntentChangedAt = '1'), 'profile'],
		['setupIntentChangedAt -1', (p) => (p.profile.setupIntentChangedAt = -1), 'profile'],
		["setupIntent 'pending'", (p) => (p.profile.setupIntent = 'pending'), 'profile'],
		['schemaVersion 2 in the profile', (p) => (p.profile.schemaVersion = 2), 'profile'],
		['eaos null', (p) => (p.profile.eaos = null), 'profile'],
		['eaos empty', (p) => (p.profile.eaos = ''), 'profile'],
		['eaos without padding', (p) => (p.profile.eaos = 'MjAyNy0wNi0zMA'), 'profile'],
		['eaos with a space in it', (p) => (p.profile.eaos = 'MjAy Ny0wNi0zMA=='), 'profile'],
		['eaos in the URL-safe alphabet', (p) => (p.profile.eaos = '-jAyNy0wNi0zMA=='), 'profile'],
		// A grouped regex overflows the engine's stack on a date this long; the refusal must still be a returned answer.
		['eaos of 4.5 million characters', (p) => (p.profile.eaos = 'A'.repeat(4_500_000)), 'profile'],
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
		// Where you plan to live: only a place the finder's own parser names, in the spelling Settings saves.
		[
			'a destination of free text',
			(p) => (p.profile.geographicDestination = b64('Atlantis')),
			'profile'
		],
		[
			'a destination in a second spelling',
			(p) => (p.profile.geographicDestination = b64('maryland')),
			'profile'
		],
		[
			'a destination of four digits',
			(p) => (p.profile.geographicDestination = b64('2104')),
			'profile'
		],
		['a destination not base64', (p) => (p.profile.geographicDestination = '21046'), 'profile'],
		['an empty destination', (p) => (p.profile.geographicDestination = ''), 'profile'],
		['skillbridgeStart empty', (p) => (p.profile.skillbridgeStart = ''), 'profile'],
		['skillbridgeStart not base64', (p) => (p.profile.skillbridgeStart = '2027-03-01'), 'profile'],
		[
			'skillbridgeStart that decodes to no date',
			(p) => (p.profile.skillbridgeStart = b64('soon')),
			'profile'
		],
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
		['timeline schemaVersion 2', (p) => (p.timeline.schemaVersion = 2), 'timeline'],
		["timeline schemaVersion '1'", (p) => (p.timeline.schemaVersion = '1'), 'timeline'],
		['tasks as an array', (p) => (p.timeline.tasks = []), 'timeline'],
		[
			'an extra key in a task',
			(p) => (p.tasks['va-gov-account'] = { status: 'done', extra: 1 }),
			'timeline'
		],
		['an unknown task id', (p) => (p.tasks['not-a-task'] = { status: 'done' }), 'timeline'],
		['a task as null', (p) => (p.tasks['va-gov-account'] = null as unknown as Bag), 'timeline'],
		['a task with nothing in it', (p) => (p.tasks['va-gov-account'] = {}), 'timeline'],
		['status later', (p) => (p.tasks['va-gov-account'] = { status: 'later' }), 'timeline'],
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
			'a note of 100,001 units',
			(p) => (p.tasks['will-poa'] = { notes: 'a'.repeat(MAX_NOTE_UNITS + 1) }),
			'timeline'
		],
		['an empty note', (p) => (p.tasks['will-poa'] = { notes: '' }), 'timeline'],
		['a note as a number', (p) => (p.tasks['will-poa'] = { notes: 5 }), 'timeline'],
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
		// The calendar.
		['an extra key in the calendar', (p) => (p.calendar.extra = 1), 'calendar'],
		['calendar schemaVersion 2', (p) => (p.calendar.schemaVersion = 2), 'calendar'],
		['an extra key in exclusions', (p) => (p.exclusions.extra = []), 'calendar'],
		['taskIds as an object', (p) => (p.exclusions.taskIds = {}), 'calendar'],
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
		['lastAdd present', (p) => (p.calendar.lastAdd = []), 'calendar'],
		['an extra key in the card', (p) => (p.card.extra = 1), 'calendar'],
		['a card as null', (p) => (p.calendar.card = null), 'calendar'],
		['dismissCount 10,001', (p) => (p.card.dismissCount = 10_001), 'calendar'],
		['dismissCount 1.5', (p) => (p.card.dismissCount = 1.5), 'calendar'],
		['dismissCount -1', (p) => (p.card.dismissCount = -1), 'calendar'],
		["dismissedAt '1'", (p) => (p.card.dismissedAt = '1'), 'calendar'],
		['dismissedAt 8.64e15 + 1', (p) => (p.card.dismissedAt = 8.64e15 + 1), 'calendar'],
		// The finder: what export writes and nothing else, at every level.
		['a finder record of null', (p) => (p.stores['skillbridge-finder'] = null), 'finder'],
		['a finder record that is a list', (p) => (p.stores['skillbridge-finder'] = []), 'finder'],
		...finderCases()
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
		['the finder record', '"skillbridge-finder":{', '"skillbridge-finder":{"__proto__":{},'],
		['the finder setup', '"finderSetup":{', '"finderSetup":{"__proto__":{},'],
		['a finder place', '"place":{', '"place":{"__proto__":{},'],
		['the finder filters', '"finderFilters":{', '"finderFilters":{"__proto__":[],'],
		['a saved program', '"finderSaved":[{', '"finderSaved":[{"__proto__":{},'],
		['a saved listing', '"facts":{', '"facts":{"__proto__":{},']
	] as const)('an own __proto__ key in %s', (_name, anchor, inserted) => {
		const parts = goodParts();
		withFinder()(parts);
		const text = JSON.stringify(parts.inner).replace(anchor, inserted);
		expect(text).not.toBe(JSON.stringify(parts.inner));
		expect(validateInner(JSON.parse(text))).toEqual(refusal('finder'));
	});

	it('a file that is null is CONTENT_INVALID', () => {
		expect(validateInner(null)).toEqual(refusal());
	});
});

// The finder's refusals again, with a codec that reads back whatever it is given. The check above passes whether the
// validator's own lines or the codec refuse, so a rule that only the codec enforced would go unnoticed; here the
// validator alone must refuse every case. The last case is the net itself: a record the validator accepts is still
// refused when the codec cannot read it back.
describe('validateInner: the finder refusals hold on the validator alone', () => {
	beforeEach(() => {
		finderCodec.mode = 'lenient';
	});
	afterEach(() => {
		finderCodec.mode = 'real';
	});

	const cases: [string, (p: Parts) => void][] = [
		['a finder record of null', (p) => (p.stores['skillbridge-finder'] = null)],
		['a finder record that is a list', (p) => (p.stores['skillbridge-finder'] = [])],
		...finderCases().map(([name, edit]): [string, (p: Parts) => void] => [name, edit])
	];

	it.each(cases)('%s', (_name, edit) => {
		expect(validateInner(make(edit))).toEqual(refusal('finder'));
	});

	it('a record the codec cannot read back is refused', () => {
		finderCodec.mode = 'throws';
		expect(validateInner(make(withFinder()))).toEqual(refusal('finder'));
	});
});

// The bytes handed to a shipped decoder hold the person's plaintext record, so the check wipes them whether the decoder
// reads them back, disagrees or throws (the profile's own buffers are wiped the same way).
describe('validateInner: the bytes a check decodes are wiped', () => {
	beforeEach(() => {
		finderCodec.seen = [];
	});
	afterEach(() => {
		finderCodec.mode = 'real';
	});

	const expectWiped = () => {
		expect(finderCodec.seen).toHaveLength(1);
		const bytes = finderCodec.seen[0] as Uint8Array;
		expect(bytes.length).toBeGreaterThan(0);
		expect(bytes.every((b) => b === 0)).toBe(true);
	};

	it('after a decode that reads the record back', () => {
		expect(validateInner(make(withFinder())).ok).toBe(true);
		expectWiped();
	});

	it('after a decoder that throws', () => {
		finderCodec.mode = 'throws';
		expect(validateInner(make(withFinder()))).toEqual(refusal('finder'));
		expectWiped();
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

	// Every container of the finder record is checked for its type before it is entered.
	it('a 100,000-deep nested array in any part of the finder record is CONTENT_INVALID and does not throw', () => {
		const deep = (): unknown => {
			let value: unknown = [];
			for (let i = 0; i < 100_000; i += 1) value = [value];
			return value;
		};
		const places: [string, (f: Bag) => void][] = [
			['a saved item', (f) => ((f.finderSaved as unknown[])[0] = deep())],
			['a saved listing', (f) => (((f.finderSaved as Bag[])[0] as Bag).facts = deep())],
			['a listing field', (f) => ((((f.finderSaved as Bag[])[0] as Bag).facts as Bag).r = deep())],
			['the setup', (f) => (f.finderSetup = deep())],
			['a place', (f) => ((f.finderSetup as Bag).place = deep())],
			['a filter list', (f) => ((f.finderFilters as Bag).industries = deep())],
			['a compare id', (f) => (f.finderCompare = [deep()])]
		];
		for (const [place, edit] of places) {
			// Built first and deepened after, as JSON.stringify itself would run out of stack on the deep value.
			const file = make(withFinder());
			edit(((file as Bag).stores as Bag)['skillbridge-finder'] as Bag);
			let result: ReturnType<typeof validateInner> | undefined;
			expect(() => {
				result = validateInner(file);
			}, place).not.toThrow();
			expect(result, place).toEqual(refusal('finder'));
		}
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

	// The check decodes the person's dates into bytes to compare them; those bytes must not outlive it.
	it('the profile record the round trip decodes is wiped before validation returns', () => {
		wiped.records.length = 0;
		expect(validateInner(make()).ok).toBe(true);
		expect(wiped.records).toHaveLength(1);
		const bytes = Object.values(wiped.records[0]!).filter((v) => v instanceof Uint8Array);
		expect(bytes.length).toBeGreaterThan(0);
		for (const field of bytes) {
			expect(field.length).toBeGreaterThan(0);
			expect(field.every((b) => b === 0)).toBe(true);
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
