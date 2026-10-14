import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { AskState } from '$lib/ask';
import { generateTimeline, TASK_DEFS } from '$lib/timeline';
import { selectNeedsNow } from '$lib/timeline/needs-now';
import { addDays, localTodayIso } from '$lib/timeline/day-math';
import { textOf } from '$lib/timeline/personal-claim';
import type { EaosString } from '$lib/profile/eaos';
import type { PersonaFilters } from '$lib/profile/persona';
import HomePage from './+page.svelte';

// The Ask store is replaced by one the test controls; the cache read that makes it lands at once.
const fake = $state<{ state: AskState }>({ state: { kind: 'idle' } });
const store = {
	get state() {
		return fake.state;
	},
	mode: 'online' as const,
	showNudge: false,
	ask: async () => {},
	setMode: () => {},
	setUp: async () => {},
	dismissSetup: () => {},
	consentOnline: async () => {},
	stayOnDevice: async () => {},
	dismissNudge: () => {}
};

// The profile app the page reads: a returning user's profile and timeline stores, set per test.
const EMPTY = { schemaVersion: 1 as const, tasks: {} };
const app = $state<{
	status: string;
	store: { locked: boolean; persona: PersonaFilters } | null;
	timeline: { locked: boolean; ready: boolean; failed: boolean; state: typeof EMPTY } | null;
	byok: null;
}>({ status: 'ready', store: null, timeline: null, byok: null });

vi.mock('$lib/ask', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/ask')>()),
	createAskStore: () => store,
	createRecoveringEmbed: () => ({ embed: async () => [], dispose: () => {} })
}));
vi.mock('$lib/ask/embed-worker?worker', () => ({ default: class {} }));
vi.mock('$lib/ask/device-files', () => ({ deviceFilesKept: async () => true }));
vi.mock('$lib/profile/context', () => ({ getProfileApp: () => app, setProfileApp: () => {} }));
// The Home row's code is fetched through this loader, so a test can see whether it was fetched, and make it fail.
type Loader = typeof import('$lib/timeline/load-home-glance').loadHomeGlance;
const glance = vi.hoisted(() => ({ load: vi.fn(), real: null as unknown as Loader }));
vi.mock('$lib/timeline/load-home-glance', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/timeline/load-home-glance')>();
	glance.real = real.loadHomeGlance;
	return { ...real, loadHomeGlance: () => glance.load() };
});
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({ canPrompt: false, installed: true, ios: false, persisted: false }),
	setInstallApp: () => {}
}));

// A separation date 93 days out, so some tasks are late or closing soon on any day the test runs.
const today = localTodayIso(new Date());
const persona: PersonaFilters = {
	completeness: 'eaos-only',
	eaos: addDays(today, 93) as EaosString,
	daysUntilSeparation: 93
};
const NO_PERSONA = { completeness: 'none' } as PersonaFilters;

const row = () => document.querySelector<HTMLAnchorElement>('a.glance');
// Each line exactly as the page holds it, so a lost space shows.
const lines = () => [
	row()?.querySelector('.glance__name')?.textContent,
	row()?.querySelector('.glance__detail')?.textContent
];

beforeEach(() => {
	glance.load.mockReset();
	glance.load.mockImplementation(() => glance.real());
	fake.state = { kind: 'idle' };
	app.status = 'ready';
	app.store = { locked: false, persona };
	app.timeline = { locked: false, ready: true, failed: false, state: EMPTY };
});

describe('Home, the timeline row', () => {
	it('gives the Timeline summary count and links to the Timeline', async () => {
		await render(HomePage);
		const view = generateTimeline(persona, [...TASK_DEFS], EMPTY, new Date());
		const g = selectNeedsNow(
			view.phases.flatMap((p) => p.items),
			view.todayDate!
		);
		const total = Object.values(g).reduce((n, list) => n + list.length, 0);
		expect(total).toBeGreaterThan(1);
		await expect.poll(() => row()).not.toBeNull();
		expect(lines()[0]).toBe(`Your timeline - ${total} need you now`);
		expect(row()!.getAttribute('href')).toBe('/timeline');
	});

	it('sits in a section headed for screen readers, after Ask', async () => {
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		const section = row()!.closest('section')!;
		const heading = section.querySelector('h2')!;
		expect(heading.textContent).toBe('For you');
		expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
		expect(section.getAttribute('aria-live')).toBeNull();
		const field = document.querySelector('.ask-input')!;
		expect(field.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it('shows no task and no date while the profile is locked', async () => {
		app.store = { locked: true, persona: NO_PERSONA };
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		const text = textOf(row()!);
		expect(lines()).toEqual(['Your timeline - locked', 'Unlock to see what is due']);
		for (const def of TASK_DEFS) expect(text).not.toContain(def.title);
		expect(document.querySelector('.home-onramp')).toBeNull();
	});

	it('shows the locked row when only the timeline store is locked', async () => {
		app.timeline = { locked: true, ready: false, failed: false, state: EMPTY };
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		expect(lines()).toEqual(['Your timeline - locked', 'Unlock to see what is due']);
	});

	it('says it could not load when the timeline store failed', async () => {
		app.timeline = { locked: true, ready: false, failed: true, state: EMPTY };
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		expect(lines()).toEqual(['Your timeline', 'Could not load it here - open the Timeline']);
	});

	it('shows no row while the timeline is still loading, never a false "nothing"', async () => {
		app.timeline = { locked: false, ready: false, failed: false, state: EMPTY };
		await render(HomePage);
		// The row's code is in, so only the loading timeline holds the row back.
		await expect.poll(() => glance.load.mock.results.length).toBe(1);
		await glance.load.mock.results[0]!.value;
		await new Promise((r) => setTimeout(r, 50));
		expect(document.querySelector('.ask-input')).not.toBeNull();
		expect(row()).toBeNull();
		app.timeline = { locked: false, ready: true, failed: false, state: EMPTY };
		await expect.poll(() => row()).not.toBeNull();
	});

	it('keeps the first-run card, and no row, for a user with no timeline - and fetches none of its code', async () => {
		app.store = { locked: false, persona: NO_PERSONA };
		await render(HomePage);
		await expect.poll(() => document.querySelector('.home-onramp')).not.toBeNull();
		await new Promise((r) => setTimeout(r, 50));
		expect(row()).toBeNull();
		expect(glance.load).not.toHaveBeenCalled();
	});

	it('says it could not load when the row code fails to arrive', async () => {
		glance.load.mockImplementation(() => Promise.reject(new Error('chunk failed')));
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		expect(lines()).toEqual(['Your timeline', 'Could not load it here - open the Timeline']);
		expect(glance.load).toHaveBeenCalledOnce();
	});

	it('turns to the locked row, with no task left on screen, when the app locks while Home is open', async () => {
		await render(HomePage);
		await expect.poll(() => lines()[0]).toMatch(/need you now$/);
		app.store = { locked: true, persona: NO_PERSONA };
		await expect
			.poll(() => lines())
			.toEqual(['Your timeline - locked', 'Unlock to see what is due']);
		for (const def of TASK_DEFS) expect(textOf(row()!)).not.toContain(def.title);
	});

	it('turns to the locked row when the timeline store alone locks while Home is open', async () => {
		await render(HomePage);
		await expect.poll(() => lines()[0]).toMatch(/need you now$/);
		app.timeline = { locked: true, ready: false, failed: false, state: EMPTY };
		await expect
			.poll(() => lines())
			.toEqual(['Your timeline - locked', 'Unlock to see what is due']);
	});

	it('steps aside while answers show', async () => {
		await render(HomePage);
		await expect.poll(() => row()).not.toBeNull();
		fake.state = { kind: 'embedding' };
		await expect.poll(() => row()).toBeNull();
		fake.state = { kind: 'idle' };
		await expect.poll(() => row()).not.toBeNull();
	});
});
