import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

// Days from the real clock: the page builds the timeline from today.
const { isoFromToday, current } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	// The timeline store as the layout hands it over: null until its first load settles. `firstRun` is a profile with
	// nothing saved yet.
	current: {
		firstRun: false,
		// Days from today to the separation date.
		daysOut: 200,
		timeline: null as null | {
			ready: boolean;
			failed: boolean;
			locked?: boolean;
			state: {
				schemaVersion: 1;
				tasks: Record<string, { status?: 'done' | 'skipped' | 'snoozed'; snoozeUntil?: string }>;
			};
			setStatus?: (taskId: string, status: 'done' | 'skipped' | 'snoozed') => Promise<void>;
			setSnooze?: (taskId: string, untilIso: string) => Promise<void>;
			refresh?: () => Promise<void>;
		}
	}
}));

// The profile is unlocked with a separation date; each test sets where the timeline's saved progress stands.
vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store: {
			locked: false,
			clockBackward: false,
			persona: current.firstRun
				? { completeness: 'none' }
				: {
						completeness: 'eaos-only',
						eaos: isoFromToday(current.daysOut),
						daysUntilSeparation: current.daysOut
					}
		},
		timeline: current.timeline,
		calendar: null,
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));

const NOTE =
	"Your saved progress couldn't be loaded, so your tasks aren't shown. Reload to try again. If it keeps happening, you can erase all data in Settings and start again.";
const EMPTY = { schemaVersion: 1 as const, tasks: {} };

describe('Timeline, its saved progress', () => {
	// A list drawn from nothing would show every task as not started, and its buttons would do nothing.
	it('says so in place of the list when the progress fails to load', async () => {
		current.timeline = { ready: false, failed: true, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect.element(page.getByRole('alert')).toHaveTextContent(NOTE);
		await expect.element(page.getByRole('button', { name: 'Reload' })).toBeVisible();
		await expect
			.element(page.getByRole('alert').getByRole('link', { name: 'Settings' }))
			.toHaveAttribute('href', '/settings');
		expect(container.querySelector('.timeline-list')).toBeNull();
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	// A re-read that fails after a good one leaves statuses that may be out of date: the note, not the list.
	it('says so in place of the list when a re-read fails after a good load', async () => {
		current.timeline = { ready: true, failed: true, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect.element(page.getByRole('alert')).toHaveTextContent(NOTE);
		expect(container.querySelector('.timeline-list')).toBeNull();
	});

	// The profile opened but the timeline stayed locked (a tab hidden while Unlock read it): Unlock again, not a blank page.
	it('offers Unlock while the timeline stays locked', async () => {
		current.timeline = { ready: false, failed: false, locked: true, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		expect(container.querySelector('.timeline-list')).toBeNull();
	});

	// With nothing saved there is nothing to unlock: a first-run tab locked by idle or another tab still offers setup.
	it('offers setup, not Unlock, when nothing is saved yet', async () => {
		current.firstRun = true;
		current.timeline = { ready: false, failed: false, locked: true, state: EMPTY };
		try {
			render(TimelinePage);
			await expect.element(page.getByRole('link', { name: 'Get started' })).toBeVisible();
			expect(page.getByRole('button', { name: 'Unlock' }).elements()).toHaveLength(0);
		} finally {
			current.firstRun = false;
		}
	});

	// A locked timeline whose load failed says so: Unlock would only fail again.
	it('says the load failed, not Unlock, when the locked timeline could not be read', async () => {
		current.timeline = { ready: false, failed: true, locked: true, state: EMPTY };
		render(TimelinePage);
		await expect.element(page.getByRole('alert')).toHaveTextContent(NOTE);
		expect(page.getByRole('button', { name: 'Unlock' }).elements()).toHaveLength(0);
	});

	// On a normal start the list waits for the progress instead of flashing every task as not started.
	it('shows neither while the progress loads', async () => {
		current.timeline = null;
		const { container } = render(TimelinePage);
		await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
		expect(container.querySelector('.timeline-list')).toBeNull();
		expect(container.textContent).not.toContain("couldn't be loaded");
	});

	it('shows the list once the progress has loaded', async () => {
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect
			.element(page.getByRole('button', { name: 'Mark done' }).first())
			.toBeInTheDocument();
		expect(container.querySelector('.timeline-list')).not.toBeNull();
		expect(container.textContent).not.toContain("couldn't be loaded");
	});
});

describe('Timeline, the SkillBridge question', () => {
	it('asks once the progress has loaded, before the list', async () => {
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect
			.element(page.getByRole('heading', { name: 'Planning to do SkillBridge?' }))
			.toBeVisible();
		const card = container.querySelector('.sb-card');
		const list = container.querySelector('.timeline-list');
		expect(
			card && list && card.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('asks after Needs you now', async () => {
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = render(TimelinePage);
		await expect.element(page.getByRole('heading', { name: /Needs you now/ })).toBeVisible();
		const needs = container.querySelector('.needs-now');
		const card = container.querySelector('.sb-card');
		expect(
			needs && card && needs.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('does not ask once answered', async () => {
		current.timeline = {
			ready: true,
			failed: false,
			state: { schemaVersion: 1, tasks: { 'skillbridge-plan': { status: 'skipped' } } }
		};
		const { container } = render(TimelinePage);
		await expect
			.element(page.getByRole('button', { name: 'Mark done' }).first())
			.toBeInTheDocument();
		expect(container.querySelector('.sb-card')).toBeNull();
	});

	it('does not ask while the progress is locked or failed', async () => {
		for (const t of [
			{ ready: false, failed: false, locked: true, state: EMPTY },
			{ ready: true, failed: true, state: EMPTY }
		]) {
			current.timeline = t;
			const { container, unmount } = render(TimelinePage);
			await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
			expect(container.querySelector('.sb-card')).toBeNull();
			unmount();
		}
	});

	it('does not ask while the progress is still loading', async () => {
		for (const t of [null, { ready: false, failed: false, state: EMPTY }]) {
			current.timeline = t;
			const { container, unmount } = render(TimelinePage);
			await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
			expect(container.querySelector('.sb-card')).toBeNull();
			unmount();
		}
	});

	it('does not ask from three weeks before separation', async () => {
		current.daysOut = 20;
		try {
			current.timeline = { ready: true, failed: false, state: EMPTY };
			const { container } = render(TimelinePage);
			await expect
				.element(page.getByRole('button', { name: 'Mark done' }).first())
				.toBeInTheDocument();
			expect(container.querySelector('.sb-card')).toBeNull();
		} finally {
			current.daysOut = 200;
		}
	});

	// A store whose state changes when a write lands, as the real one does.
	function liveStore(save: 'lands' | 'fails') {
		const setStatus = vi.fn(async (taskId: string, status: 'done' | 'skipped' | 'snoozed') => {
			if (save === 'fails') throw new Error('E_TEST');
			store.state = { schemaVersion: 1, tasks: { [taskId]: { status } } };
		});
		const setSnooze = vi.fn(async (taskId: string, untilIso: string) => {
			if (save === 'fails') throw new Error('E_TEST');
			store.state = {
				schemaVersion: 1,
				tasks: { [taskId]: { status: 'snoozed', snoozeUntil: untilIso } }
			};
		});
		const refresh = vi.fn(async () => {});
		const store = $state({
			ready: true,
			failed: false,
			state: { schemaVersion: 1 as const, tasks: {} } as NonNullable<
				typeof current.timeline
			>['state'],
			setStatus,
			setSnooze,
			refresh
		});
		return { store, setStatus, setSnooze, refresh };
	}

	it('saves Yes as done through the store and keeps the card for its status line', async () => {
		const { store, setStatus, setSnooze, refresh } = liveStore('lands');
		current.timeline = store;
		const { container } = render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		// The store now holds the answer, which hides the question; the card stays to say what happened.
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('SkillBridge steps added to your timeline.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'done');
		expect(setSnooze).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(container.querySelectorAll('.sb-card')).toHaveLength(1);
	});

	it('keeps the answered card until Dismiss, then removes it and moves focus to the first task', async () => {
		const { store } = liveStore('lands');
		current.timeline = store;
		const { container } = render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect.element(page.getByRole('status')).toBeVisible();
		expect(container.querySelectorAll('.sb-card')).toHaveLength(1);

		await page.getByRole('button', { name: 'Dismiss' }).click();
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		const first = document.querySelector<HTMLElement>('[id^="task-"]');
		expect(first).not.toBeNull();
		expect(document.activeElement).toBe(first);
	});

	it('saves No as skipped', async () => {
		const { store, setStatus } = liveStore('lands');
		current.timeline = store;
		render(TimelinePage);
		await page.getByRole('button', { name: 'No', exact: true }).click();
		await expect.element(page.getByRole('status')).toHaveTextContent('Got it.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'skipped');
	});

	it('saves Not sure as snoozed when it is the second ask', async () => {
		const { store, setStatus, setSnooze } = liveStore('lands');
		current.timeline = store;
		render(TimelinePage);
		await page.getByRole('button', { name: 'Not sure' }).click();
		await expect.element(page.getByRole('status')).toBeVisible();
		// From the second ask a Not sure shows the steps, so it says what a Yes says.
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent('SkillBridge steps added to your timeline.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'snoozed');
		expect(setSnooze).not.toHaveBeenCalled();
	});

	it('saves Not sure with the day the card returns when it is the first ask', async () => {
		current.daysOut = 600;
		try {
			const { store, setStatus, setSnooze } = liveStore('lands');
			current.timeline = store;
			render(TimelinePage);
			await expect
				.element(page.getByRole('heading', { name: 'Planning to do SkillBridge?' }))
				.toBeVisible();
			await page.getByRole('button', { name: 'Not sure' }).click();
			await expect.element(page.getByRole('status')).toHaveTextContent("We'll ask again on");
			expect(setSnooze).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', isoFromToday(144));
			expect(setStatus).not.toHaveBeenCalled();
		} finally {
			current.daysOut = 200;
		}
	});

	it('says a failed save failed, re-reads the store and keeps the question', async () => {
		const { store, setStatus, refresh } = liveStore('fails');
		current.timeline = store;
		render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
		expect(setStatus).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		await expect.element(page.getByRole('button', { name: 'Yes' })).toBeEnabled();
	});

	it('lets the question go when the re-read after a failed save shows another tab answered it', async () => {
		const { store, refresh } = liveStore('fails');
		refresh.mockImplementation(async () => {
			store.state = { schemaVersion: 1, tasks: { 'skillbridge-plan': { status: 'skipped' } } };
		});
		current.timeline = store;
		const { container } = render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
	});
});
