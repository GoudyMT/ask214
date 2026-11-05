import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import type { ProfileApp } from '#lib/profile/context.js';
import type { SeparationPath } from '#lib/profile/separation-path.js';
import { createProfileStore } from '#lib/profile/store.svelte.js';
import { createTimelineStateStore } from '#lib/timeline/state.svelte.js';
import { localTodayIso, addDays } from '#lib/timeline/day-math.js';
import { bootstrapLocalKeystore } from '#lib/keystore/bootstrap.js';
import { deleteTestDb, openTestDb } from '#lib/db/_test-helpers.js';
import TimelinePage from './+page.svelte';

// The page runs on the real profile and timeline stores over a test database; only the app container the layout would
// hand it is replaced.
const harness = vi.hoisted(() => ({ app: null as ProfileApp | null }));
vi.mock('#lib/profile/context.js', () => ({
	getProfileApp: () => harness.app,
	setProfileApp: () => {}
}));

const LINE = 'If the board moves your separation date, update it in Settings.';

let db: IDBDatabase | null = null;

/** A device whose separation date is `days` from today, with the leaving answer given. */
async function device(days: number, separationPath?: SeparationPath): Promise<void> {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	const store = createProfileStore(db);
	await store.save({
		eaos: new TextEncoder().encode(addDays(localTodayIso(new Date()), days)),
		setupIntent: 'completed',
		...(separationPath && { separationPath: new TextEncoder().encode(separationPath) })
	});
	await store.load();
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	harness.app = {
		status: 'ready',
		store,
		timeline,
		calendar: null,
		byok: null,
		cause: null,
		db,
		wipeAll: null,
		relockAll: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	};
}

/** The page is up and, a moment later, still shows no line: a line that came late would pass an immediate check. */
async function expectNoLine(): Promise<void> {
	await expect.element(page.getByText('Anchored to')).toBeVisible();
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(page.getByText(LINE).query()).toBeNull();
}

beforeEach(() => {
	harness.app = null;
});

afterEach(async () => {
	if (db) await deleteTestDb(db);
	db = null;
});

// A medical board can move the separation date either way. Moved earlier, steps stay timed to the old date until the
// member changes it; moved later, the passed date closes required steps. So the line stands whatever the date is.
describe('the Timeline for a medical board', () => {
	it.each([
		['the date has passed', -1],
		['the date is today', 0],
		['the date is ahead', 30]
	])('says to update the date, with the way to Settings, when %s', async (_name, days) => {
		await device(days, 'medical');
		await render(TimelinePage);
		await expect.element(page.getByText(LINE)).toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Settings', exact: true }))
			.toHaveAttribute('href', '/settings');
		// It follows the date line it explains, before anything else on the page.
		const dateLine = page.getByText('Anchored to').element();
		expect(dateLine.nextElementSibling).toBe(page.getByText(LINE).element());
	});

	it.each([
		['another answer, the date ahead', 30, 'retirement'],
		['another answer, the date passed', -1, 'retirement'],
		['no answer, the date ahead', 30, undefined],
		['no answer, the date passed', -1, undefined]
	] as const)('says nothing when %s', async (_name, days, path) => {
		await device(days, path);
		await render(TimelinePage);
		await expectNoLine();
	});
});
