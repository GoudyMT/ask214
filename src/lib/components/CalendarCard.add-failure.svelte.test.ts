import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import CalendarCard from './CalendarCard.svelte';
import type { TimelineItem } from '$lib/timeline/generate';
import type { TaskDef } from '$lib/timeline/types';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

// Its own file so the mock reaches no other test: the first build rejects, as a browser that cannot make the file would.
// The path is a `$lib` alias on purpose: a relative path silently never applies to the component's own import here.
const seams = vi.hoisted(() => ({ failNext: true }));
vi.mock('$lib/calendar/build-ics', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/calendar/build-ics')>();
	return {
		...real,
		buildIcs: (...args: Parameters<typeof real.buildIcs>) => {
			if (seams.failNext) {
				seams.failNext = false;
				return Promise.reject(new Error('E_TEST_BUILD'));
			}
			return real.buildIcs(...args);
		}
	};
});

const LINE = 'Could not make the calendar file right now - please try again.';

// Dated ahead of the real clock: the calendar file never carries an event before today.
const ahead = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
const def: TaskDef = {
	id: 'a',
	title: 'a',
	category: 'admin',
	finishBefore: 'separation',
	kind: 'soft',
	windowStart: -30,
	windowEnd: 0,
	why: ''
};
const task: TimelineItem = {
	def,
	targetDate: ahead,
	windowStartDate: ahead,
	windowEndDate: ahead,
	status: 'start-now',
	aimDate: ahead
};

beforeEach(() => {
	seams.failNext = true;
});

describe('CalendarCard, when the file cannot be made', () => {
	it('says so under the Add button, and takes the line away on the next tap', async () => {
		const onAdd = vi.fn();
		const { container } = await render(CalendarCard, {
			props: {
				items: [task],
				exclusions: { taskIds: [], categories: [] },
				onAdd,
				onDismiss: vi.fn()
			}
		});
		const add = page.getByRole('button', { name: /^add to my calendar$/i });

		await add.click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(LINE);
		await expect.element(add).toBeEnabled();
		expect(onAdd).not.toHaveBeenCalled();
		// Its own class, so the card's two device hints stay exactly two.
		expect(container.querySelector('[role="alert"]')?.className).toContain('cal-card__error');
		expect(container.querySelector('[role="alert"]')?.className).not.toContain('cal-card__hint');
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);

		await add.click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});
});
