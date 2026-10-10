import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';
import { formatTimelineDate } from '$lib/timeline/format-date';
import { TASK_DEFS } from '$lib/timeline';

// Days from the real clock: the page builds the timeline from today.
const { isoFromToday, current, handOver } = vi.hoisted(() => ({
	handOver: vi.fn(async () => {}),
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
		// The calendar store as far as the page and its card read it; null leaves the card off the page.
		calendar: null as null | {
			ready: boolean;
			exclusions: { taskIds: string[]; categories: string[] };
			card: { dismissedAt?: number; dismissCount?: number };
			dismissCard: (now: number) => Promise<void>;
			refresh?: () => Promise<void>;
		},
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
			setNote?: (taskId: string, note: string | undefined) => Promise<void>;
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
		calendar: current.calendar,
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));

// The page's own hand-over of the calendar file would start a real download.
vi.mock('$lib/calendar/hand-over', () => ({ handOver }));

const NOTE =
	"Your saved progress couldn't be loaded, so your tasks aren't shown. Reload to try again. If it keeps happening, you can erase all data in Settings and start again.";
const EMPTY = { schemaVersion: 1 as const, tasks: {} };

describe('Timeline, its saved progress', () => {
	// A list drawn from nothing would show every task as not started, and its buttons would do nothing.
	it('says so in place of the list when the progress fails to load', async () => {
		current.timeline = { ready: false, failed: true, state: EMPTY };
		const { container } = await render(TimelinePage);
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
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('alert')).toHaveTextContent(NOTE);
		expect(container.querySelector('.timeline-list')).toBeNull();
	});

	// The profile opened but the timeline stayed locked (a tab hidden while Unlock read it): Unlock again, not a blank page.
	it('offers Unlock while the timeline stays locked', async () => {
		current.timeline = { ready: false, failed: false, locked: true, state: EMPTY };
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
		expect(container.querySelector('.timeline-list')).toBeNull();
	});

	// With nothing saved there is nothing to unlock: a first-run tab locked by idle or another tab still offers setup.
	it('offers setup, not Unlock, when nothing is saved yet', async () => {
		current.firstRun = true;
		current.timeline = { ready: false, failed: false, locked: true, state: EMPTY };
		try {
			await render(TimelinePage);
			await expect.element(page.getByRole('link', { name: 'Get started' })).toBeVisible();
			expect(page.getByRole('button', { name: 'Unlock' }).elements()).toHaveLength(0);
		} finally {
			current.firstRun = false;
		}
	});

	// A locked timeline whose load failed says so: Unlock would only fail again.
	it('says the load failed, not Unlock, when the locked timeline could not be read', async () => {
		current.timeline = { ready: false, failed: true, locked: true, state: EMPTY };
		await render(TimelinePage);
		await expect.element(page.getByRole('alert')).toHaveTextContent(NOTE);
		expect(page.getByRole('button', { name: 'Unlock' }).elements()).toHaveLength(0);
	});

	// On a normal start the list waits for the progress instead of flashing every task as not started.
	it('shows neither while the progress loads', async () => {
		current.timeline = null;
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
		expect(container.querySelector('.timeline-list')).toBeNull();
		expect(container.textContent).not.toContain("couldn't be loaded");
	});

	it('shows the list once the progress has loaded', async () => {
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = await render(TimelinePage);
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
		const { container } = await render(TimelinePage);
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
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('heading', { name: /Needs you now/ })).toBeVisible();
		const needs = container.querySelector('.needs-now');
		const card = container.querySelector('.sb-card');
		expect(
			needs && card && needs.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('asks with the second wording once an early Not sure has come due', async () => {
		current.timeline = {
			ready: true,
			failed: false,
			state: {
				schemaVersion: 1,
				tasks: { 'skillbridge-plan': { status: 'snoozed', snoozeUntil: isoFromToday(-1) } }
			}
		};
		await render(TimelinePage);
		await expect
			.element(page.getByRole('heading', { name: 'Still thinking about SkillBridge?' }))
			.toBeVisible();
		expect(
			page.getByRole('heading', { name: 'Planning to do SkillBridge?' }).elements()
		).toHaveLength(0);
	});

	it('does not ask once answered', async () => {
		current.timeline = {
			ready: true,
			failed: false,
			state: { schemaVersion: 1, tasks: { 'skillbridge-plan': { status: 'skipped' } } }
		};
		const { container } = await render(TimelinePage);
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
			const { container, unmount } = await render(TimelinePage);
			await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
			expect(container.querySelector('.sb-card')).toBeNull();
			await unmount();
		}
	});

	it('does not ask while the progress is still loading', async () => {
		for (const t of [null, { ready: false, failed: false, state: EMPTY }]) {
			current.timeline = t;
			const { container, unmount } = await render(TimelinePage);
			await expect.element(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
			expect(container.querySelector('.sb-card')).toBeNull();
			await unmount();
		}
	});

	it('does not ask from three weeks before separation', async () => {
		current.daysOut = 20;
		try {
			current.timeline = { ready: true, failed: false, state: EMPTY };
			const { container } = await render(TimelinePage);
			await expect
				.element(page.getByRole('button', { name: 'Mark done' }).first())
				.toBeInTheDocument();
			expect(container.querySelector('.sb-card')).toBeNull();
		} finally {
			current.daysOut = 200;
		}
	});

	// A store whose state changes when a write lands, as the real one does.
	function liveStore(
		save: 'lands' | 'fails',
		saved: NonNullable<typeof current.timeline>['state']['tasks'] = {}
	) {
		const setStatus = vi.fn(async (taskId: string, status: 'done' | 'skipped' | 'snoozed') => {
			if (save === 'fails') throw new Error('E_TEST');
			store.state = { schemaVersion: 1, tasks: { ...store.state.tasks, [taskId]: { status } } };
		});
		const setSnooze = vi.fn(async (taskId: string, untilIso: string) => {
			if (save === 'fails') throw new Error('E_TEST');
			store.state = {
				schemaVersion: 1,
				tasks: { ...store.state.tasks, [taskId]: { status: 'snoozed', snoozeUntil: untilIso } }
			};
		});
		const refresh = vi.fn(async () => {});
		const store = $state({
			ready: true,
			failed: false,
			state: { schemaVersion: 1 as const, tasks: saved } as NonNullable<
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
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		// The store now holds the answer, which hides the question; the card stays to say what happened.
		await expect
			.element(page.getByRole('status'))
			.toMatchTextContent('SkillBridge steps added to your timeline.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'done');
		expect(setSnooze).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(container.querySelectorAll('.sb-card')).toHaveLength(1);
	});

	it('keeps the answered card until Dismiss, then removes it and moves focus to the first task', async () => {
		const { store } = liveStore('lands');
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect.element(page.getByRole('status')).toBeVisible();
		expect(container.querySelectorAll('.sb-card')).toHaveLength(1);

		await page.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true }).click();
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		const first = document.querySelector<HTMLElement>('[id^="task-"]');
		expect(first).not.toBeNull();
		expect(document.activeElement).toBe(first);
	});

	// The page left open past midnight into the second-ask day: the saved Not sure now asks again, but the message the
	// person is reading has to go when they close it, not be replaced by the same card.
	it('removes the answered card on Dismiss even when the question has come due again', async () => {
		current.daysOut = 457;
		vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
		try {
			const noon = new Date();
			noon.setHours(12, 0, 0, 0);
			vi.setSystemTime(noon);
			const { store } = liveStore('lands');
			current.timeline = store;
			const { container } = await render(TimelinePage);
			await page.getByRole('button', { name: 'Not sure' }).click();
			await expect
				.element(page.getByRole('status'))
				.toMatchTextContent(`We'll ask again on ${formatTimelineDate(isoFromToday(1))}.`);

			const past = new Date(noon);
			past.setDate(past.getDate() + 1);
			past.setHours(0, 5, 0, 0);
			vi.setSystemTime(past);
			store.state = { schemaVersion: 1, tasks: { ...store.state.tasks } };
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(container.querySelectorAll('.sb-card')).toHaveLength(1);

			// The close button's scroll margin puts it where, without app.css, the chip strip overhangs it, so a pointer
			// click would land on a chip; the click is sent to the button itself.
			(
				page
					.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true })
					.element() as HTMLElement
			).click();
			await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		} finally {
			vi.useRealTimers();
			current.daysOut = 200;
		}
	});

	// A relock (tab or app switch, screen lock, idle lock) takes the store away and a restore brings it back with the
	// answer on disk: the card must not come back to ask again, where a second tap would overwrite the saved answer.
	it.each([
		['Yes', 200, 'Yes'],
		['an early Not sure', 600, 'Not sure']
	])(
		'does not ask again after %s once the store relocks and comes back',
		async (_label, daysOut, tap) => {
			current.daysOut = daysOut;
			try {
				const { store } = liveStore('lands');
				current.timeline = store;
				const { container } = await render(TimelinePage);
				await page.getByRole('button', { name: tap, exact: true }).click();
				await expect.element(page.getByRole('status')).toBeVisible();

				store.ready = false;
				await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
				store.ready = true;
				await expect
					.element(page.getByRole('button', { name: 'Mark done' }).first())
					.toBeInTheDocument();
				expect(container.querySelector('.sb-card')).toBeNull();
			} finally {
				current.daysOut = 200;
			}
		}
	);

	it('saves No as skipped', async () => {
		const { store, setStatus } = liveStore('lands');
		current.timeline = store;
		await render(TimelinePage);
		await page.getByRole('button', { name: 'No', exact: true }).click();
		await expect.element(page.getByRole('status')).toMatchTextContent('Got it.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'skipped');
	});

	it('saves Not sure as snoozed when it is the second ask', async () => {
		const { store, setStatus, setSnooze } = liveStore('lands');
		current.timeline = store;
		await render(TimelinePage);
		await page.getByRole('button', { name: 'Not sure' }).click();
		await expect.element(page.getByRole('status')).toBeVisible();
		// From the second ask a Not sure shows the steps, so it says what a Yes says.
		await expect
			.element(page.getByRole('status'))
			.toMatchTextContent('SkillBridge steps added to your timeline.');
		expect(setStatus).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', 'snoozed');
		expect(setSnooze).not.toHaveBeenCalled();
	});

	it('saves Not sure with the day the card returns when it is the first ask', async () => {
		current.daysOut = 600;
		try {
			const { store, setStatus, setSnooze } = liveStore('lands');
			current.timeline = store;
			await render(TimelinePage);
			await expect
				.element(page.getByRole('heading', { name: 'Planning to do SkillBridge?' }))
				.toBeVisible();
			await page.getByRole('button', { name: 'Not sure' }).click();
			// The line names the day the store was given, not one worked out again on screen.
			await expect
				.element(page.getByRole('status'))
				.toHaveTextContent(
					`We'll ask again on ${formatTimelineDate(isoFromToday(144))}. You can change this in Settings.`
				);
			expect(setSnooze).toHaveBeenCalledExactlyOnceWith('skillbridge-plan', isoFromToday(144));
			expect(setStatus).not.toHaveBeenCalled();
		} finally {
			current.daysOut = 200;
		}
	});

	it('says a failed save failed, re-reads the store and keeps the question', async () => {
		const { store, setStatus, refresh } = liveStore('fails');
		current.timeline = store;
		await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
		expect(setStatus).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
		await expect.element(page.getByRole('button', { name: 'Yes' })).toBeEnabled();
		// The question stays, so the person is put back on the button they tapped, not sent on to the first task.
		await expect
			.poll(() => document.activeElement)
			.toBe(page.getByRole('button', { name: 'Yes' }).element());
	});

	it('lets the question go when the re-read after a failed save shows another tab answered it', async () => {
		const { store, refresh } = liveStore('fails');
		refresh.mockImplementation(async () => {
			store.state = { schemaVersion: 1, tasks: { 'skillbridge-plan': { status: 'skipped' } } };
		});
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		// The tapped button went with the card, so focus goes to the next thing to act on, not the page body.
		const first = document.querySelector<HTMLElement>('[id^="task-"]');
		expect(first).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(first);
	});

	it('leaves focus on a task control the person moved to during the save when the re-read removes the card', async () => {
		const { store, setStatus, refresh } = liveStore('fails');
		let fail: (e: Error) => void = () => {};
		setStatus.mockImplementation(() => new Promise<void>((_, reject) => (fail = reject)));
		refresh.mockImplementation(async () => {
			store.state = { schemaVersion: 1, tasks: { 'skillbridge-plan': { status: 'skipped' } } };
		});
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		const control = page
			.getByRole('button', { name: 'Mark done' })
			.first()
			.element() as HTMLElement;
		control.focus();
		expect(document.activeElement).toBe(control);
		fail(new Error('E_TEST'));
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it('moves focus to the page heading when the re-read after a failed save leaves the progress failed', async () => {
		const { store, refresh } = liveStore('fails');
		refresh.mockImplementation(async () => {
			store.failed = true;
		});
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Yes' }).click();
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.poll(() => document.activeElement).toBe(document.querySelector('h1'));
	});

	// A fully resolved phase is collapsed, so with every task resolved no task card is on the page to take focus.
	it('moves focus to the first phase toggle after Dismiss when no task card or calendar card is on the page', async () => {
		const done = Object.fromEntries(TASK_DEFS.map((d) => [d.id, { status: 'done' as const }]));
		const { store } = liveStore('lands', done);
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'No', exact: true }).click();
		await expect.element(page.getByRole('status')).toBeVisible();
		expect(container.querySelector('[id^="task-"]')).toBeNull();
		expect(container.querySelector('.cal-card')).toBeNull();

		// Without app.css the card has no padding, so its 44 px close button overhangs the chips below it and a pointer
		// click would land on a chip; the click is sent to the button itself.
		(
			page
				.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true })
				.element() as HTMLElement
		).click();
		await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
		const toggle = container.querySelector('.timeline-list__toggle');
		expect(toggle).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(toggle);
	});

	// Closing the answered card moves the calendar card up under the spot the close button was in, so a second tap or key
	// right after the close lands on the calendar card.
	describe('Timeline, the calendar card just after the SkillBridge card closes', () => {
		const CLOSE_GUARD_WAIT_MS = 600;
		const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

		async function closeAnsweredCard() {
			const dismissCard = vi.fn(async () => {});
			current.calendar = {
				ready: true,
				exclusions: { taskIds: [], categories: [] },
				card: {},
				dismissCard
			};
			current.timeline = liveStore('lands').store;
			handOver.mockClear();
			const { container } = await render(TimelinePage);
			await page.getByRole('button', { name: 'Yes' }).click();
			await expect.element(page.getByRole('status')).toBeVisible();
			// A click sent to the element itself: without app.css the cards overlap, so a pointer click could land elsewhere.
			(
				page
					.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true })
					.element() as HTMLElement
			).click();
			await expect.poll(() => container.querySelector('.sb-card')).toBeNull();
			return { dismissCard, container };
		}

		const calendarButton = (name: string) =>
			page.getByRole('button', { name, exact: true }).element() as HTMLElement;

		it('ignores the calendar card Dismiss in the moments after the close', async () => {
			try {
				const { dismissCard, container } = await closeAnsweredCard();
				expect(container.querySelector('.cal-card')).not.toBeNull();
				calendarButton('Dismiss').click();
				await pause(100);
				expect(dismissCard).not.toHaveBeenCalled();
			} finally {
				current.calendar = null;
			}
		});

		it('ignores the calendar card Add in the moments after the close', async () => {
			try {
				await closeAnsweredCard();
				calendarButton('Add to my calendar').click();
				// The file is built before it is handed over, so a hand-over that is not coming needs a pause to show.
				await pause(200);
				expect(handOver).not.toHaveBeenCalled();
			} finally {
				current.calendar = null;
			}
		});

		it('acts on a deliberate Dismiss or Add after the guard time', async () => {
			try {
				const { dismissCard } = await closeAnsweredCard();
				await pause(CLOSE_GUARD_WAIT_MS);
				calendarButton('Dismiss').click();
				await expect.poll(() => dismissCard.mock.calls.length).toBe(1);
				calendarButton('Add to my calendar').click();
				await expect.poll(() => handOver.mock.calls.length).toBe(1);
			} finally {
				current.calendar = null;
			}
		});
	});
});

// A write that fails must reach the person (the card, or the note that the progress could not be read), never the
// console as an unhandled rejection. The page's own listener sees what the browser would report.
describe('Timeline, a write or a Dismiss that fails', () => {
	const lost: unknown[] = [];
	const onLost = (event: PromiseRejectionEvent) => {
		lost.push(event.reason);
		event.preventDefault();
	};
	const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

	beforeEach(() => {
		lost.length = 0;
		window.addEventListener('unhandledrejection', onLost);
	});
	afterEach(() => {
		window.removeEventListener('unhandledrejection', onLost);
		current.calendar = null;
	});

	// Every write fails, and so does the re-read that follows it.
	function brokenStore() {
		const fail = async () => {
			throw new Error('E_TEST');
		};
		return {
			ready: true,
			failed: false,
			state: EMPTY,
			setStatus: vi.fn(fail),
			setSnooze: vi.fn(fail),
			setNote: vi.fn(fail),
			refresh: vi.fn(fail)
		};
	}

	it('a status write that fails, with a re-read that fails too, leaves no unhandled rejection', async () => {
		const store = brokenStore();
		current.timeline = store;
		await render(TimelinePage);
		await page.getByRole('button', { name: 'Mark done' }).first().click();
		await expect.poll(() => store.refresh.mock.calls.length).toBe(1);
		await settle();
		expect(store.setStatus).toHaveBeenCalledOnce();
		expect(lost).toEqual([]);
	});

	it('a snooze write that fails, with a re-read that fails too, leaves no unhandled rejection', async () => {
		const store = brokenStore();
		current.timeline = store;
		await render(TimelinePage);
		await page.getByRole('button', { name: 'Snooze', exact: true }).first().click();
		await page.getByRole('button', { name: '1 week' }).click();
		await expect.poll(() => store.refresh.mock.calls.length).toBe(1);
		await settle();
		expect(store.setSnooze).toHaveBeenCalledOnce();
		expect(lost).toEqual([]);
	});

	it('a note write that fails, with a re-read that fails too, keeps the note and leaves no unhandled rejection', async () => {
		const store = brokenStore();
		current.timeline = store;
		const { container } = await render(TimelinePage);
		await page.getByRole('button', { name: 'Add note' }).first().click();
		await page.getByRole('textbox', { name: 'Note' }).fill('Call the VSO Monday');
		await page.getByRole('button', { name: 'Save', exact: true }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
		await settle();
		expect(store.setNote).toHaveBeenCalledOnce();
		expect(store.refresh).toHaveBeenCalledOnce();
		expect(container.querySelector('textarea')?.value).toBe('Call the VSO Monday');
		expect(lost).toEqual([]);
	});

	// A calendar store whose card state changes when a Dismiss lands, as the real one does. 'raced': the write is refused
	// because a peer tab dismissed the card first, and the re-read brings that dismissal in.
	function liveCalendar(dismiss: 'lands' | 'fails' | 'raced') {
		const refresh = vi.fn(async () => {
			if (dismiss === 'fails') throw new Error('E_TEST');
			if (dismiss === 'raced') calendar.card = { dismissedAt: Date.now(), dismissCount: 1 };
		});
		const dismissCard = vi.fn(async (now: number) => {
			if (dismiss !== 'lands') throw new Error('E_TEST');
			calendar.card = { dismissedAt: now, dismissCount: 1 };
		});
		const calendar = $state({
			ready: true,
			exclusions: { taskIds: [] as string[], categories: [] as string[] },
			card: {} as { dismissedAt?: number; dismissCount?: number },
			dismissCard,
			refresh
		});
		return { calendar, dismissCard, refresh };
	}

	const dismissButton = () =>
		page.getByRole('button', { name: 'Dismiss', exact: true }).element() as HTMLElement;

	it('a calendar card Dismiss that fails re-reads the calendar and leaves no unhandled rejection', async () => {
		const { calendar, dismissCard, refresh } = liveCalendar('fails');
		current.calendar = calendar;
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
		dismissButton().click();
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		await settle();
		expect(dismissCard).toHaveBeenCalledOnce();
		expect(lost).toEqual([]);
		// The write did not land, so the card is still there to try again.
		expect(container.querySelector('.cal-card')).not.toBeNull();
	});

	it('a calendar card Dismiss that lands while focus is on the page moves focus to the first task', async () => {
		const { calendar, dismissCard, refresh } = liveCalendar('lands');
		current.calendar = calendar;
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
		expect(document.activeElement).toBe(document.body);
		dismissButton().click();
		await expect.poll(() => container.querySelector('.cal-card')).toBeNull();
		const first = document.querySelector<HTMLElement>('[id^="task-"]');
		expect(first).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(first);
		expect(dismissCard).toHaveBeenCalledOnce();
		expect(refresh).not.toHaveBeenCalled();
	});

	// The write is refused and the re-read takes the card away: the button that held focus goes with it.
	it('a calendar card Dismiss that fails, with a re-read that removes the card, moves focus to the first task', async () => {
		const { calendar, dismissCard, refresh } = liveCalendar('raced');
		current.calendar = calendar;
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
		dismissButton().focus();
		expect(document.activeElement).toBe(dismissButton());
		dismissButton().click();
		await expect.poll(() => container.querySelector('.cal-card')).toBeNull();
		const first = document.querySelector<HTMLElement>('[id^="task-"]');
		expect(first).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(first);
		expect(dismissCard).toHaveBeenCalledOnce();
		expect(refresh).toHaveBeenCalledOnce();
	});

	it('a calendar card Dismiss that fails and leaves the card up keeps focus on its button', async () => {
		const { calendar, refresh } = liveCalendar('fails');
		current.calendar = calendar;
		current.timeline = { ready: true, failed: false, state: EMPTY };
		const { container } = await render(TimelinePage);
		await expect.element(page.getByRole('button', { name: 'Dismiss', exact: true })).toBeVisible();
		const button = dismissButton();
		button.focus();
		button.click();
		await expect.poll(() => refresh.mock.calls.length).toBe(1);
		await settle();
		expect(container.querySelector('.cal-card')).not.toBeNull();
		expect(document.activeElement).toBe(button);
	});
});
