import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import CalendarCard from './CalendarCard.svelte';
import type { TimelineItem } from '$lib/timeline/generate';
import type { TaskDef } from '$lib/timeline/types';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

// Its own file so the mock reaches no other test: the first build rejects, as a browser that cannot make the file would.
// The path is a `$lib` alias on purpose: a relative path silently never applies to the component's own import here.
// A build can also be held: it finishes only once `gate` is open, so a test can look at the page while it runs.
const seams = vi.hoisted(() => ({ failNext: true, gate: null as Promise<void> | null }));
vi.mock('$lib/calendar/build-ics', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/calendar/build-ics')>();
	return {
		...real,
		buildIcs: async (...args: Parameters<typeof real.buildIcs>) => {
			await seams.gate;
			if (seams.failNext) {
				seams.failNext = false;
				throw new Error('E_TEST_BUILD');
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

const DANGER = 'rgb(200, 0, 0)';
// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

beforeEach(() => {
	seams.failNext = true;
	seams.gate = null;
	// Component tests run without app.css, so the colour token is set here and put back.
	document.documentElement.style.setProperty('--color-danger', DANGER);
});
afterEach(() => {
	document.documentElement.style.removeProperty('--color-danger');
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
		// Right under the button that asked for the file, above the device hints, in the danger colour.
		const alert = container.querySelector('[role="alert"]') as HTMLElement;
		expect(container.querySelector('.cal-card__add')?.nextElementSibling).toBe(alert);
		expect(getComputedStyle(alert).color).toBe(DANGER);
	});

	// The line goes at the tap, not when the next file is made: a build that is still running leaves no stale failure up.
	it('takes the line away at the next tap, while that build is still running', async () => {
		const onAdd = vi.fn();
		await render(CalendarCard, {
			props: {
				items: [task],
				exclusions: { taskIds: [], categories: [] },
				onAdd,
				onDismiss: vi.fn()
			}
		});
		const add = page.getByRole('button', { name: /^add to my calendar$/i });
		await add.click();
		await expect.element(page.getByRole('alert')).toBeVisible();

		let open = () => {};
		seams.gate = new Promise<void>((resolve) => (open = resolve));
		await add.click();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
		expect(onAdd).not.toHaveBeenCalled();

		open();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	// Add stays on while the file builds, so it never drops focus; a press while it builds does nothing.
	it.each([
		['cannot be made', true],
		['is made', false]
	] as const)('keeps focus on Add while the file builds and once it %s', async (_, fails) => {
		seams.failNext = fails;
		let open = () => {};
		seams.gate = new Promise<void>((resolve) => (open = resolve));
		const onAdd = vi.fn();
		const { container } = await render(CalendarCard, {
			props: {
				items: [task],
				exclusions: { taskIds: [], categories: [] },
				onAdd,
				onDismiss: vi.fn()
			}
		});
		const button = container.querySelector('.cal-card__add') as HTMLButtonElement;
		const add = page.getByRole('button', { name: /^add to my calendar$/i });
		await add.click();
		await expect.poll(() => button.getAttribute('aria-busy')).toBe('true');
		expect(button.disabled).toBe(false);
		expect(document.activeElement).toBe(button);
		await add.click();
		open();
		await expect.poll(() => button.getAttribute('aria-busy')).toBe('false');
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(onAdd).toHaveBeenCalledTimes(fails ? 0 : 1);
		expect(document.activeElement).toBe(button);
	});

	// A held key repeats about every 40 ms; each repeat that reached Add would make and hand over another file. A new
	// press still makes one. The keys go through the browser's own input, so a repeat is a real one.
	it.each([
		['builds at once', 0],
		['takes a while to build', 100]
	] as const)('makes one file for a held Enter on Add when the file %s', async (_, ms) => {
		seams.failNext = false;
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
		(container.querySelector('.cal-card__add') as HTMLButtonElement).focus();
		if (ms) seams.gate = new Promise<void>((resolve) => setTimeout(resolve, ms));
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		for (let i = 0; i < 15; i++) {
			await new Promise((resolve) => setTimeout(resolve, 40));
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await expect.element(add).toHaveAttribute('aria-busy', 'false');
		expect(onAdd).toHaveBeenCalledOnce();

		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
	});
});
