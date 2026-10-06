import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import TimelinePage from './+page.svelte';

// Days from the real clock: the page builds the timeline from today.
const { isoFromToday, current } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	// The timeline store as the layout hands it over: null until its first load settles.
	current: {
		timeline: null as null | {
			ready: boolean;
			failed: boolean;
			locked?: boolean;
			state: { schemaVersion: 1; tasks: Record<string, never> };
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
			persona: { completeness: 'eaos-only', eaos: isoFromToday(200), daysUntilSeparation: 200 }
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
