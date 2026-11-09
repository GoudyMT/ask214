import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import CalendarPanel from './CalendarPanel.svelte';
import type { TimelineItem } from '#lib/timeline/generate.js';
import type { TaskDef } from '#lib/timeline/types.js';
import type { DesiredEvent } from '#lib/calendar/types.js';
import type { CalendarFile } from '#lib/calendar/build-ics.js';
import { makesPersonalClaim, textOf } from '#lib/timeline/personal-claim.js';

// A build can be held: it finishes only once `gate` is open, so a held key's repeats can land while it runs.
const seams = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock('#lib/calendar/build-ics.js', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/calendar/build-ics.js')>();
	return {
		...real,
		buildIcs: async (...args: Parameters<typeof real.buildIcs>) => {
			await seams.gate;
			return real.buildIcs(...args);
		}
	};
});

// Dated ahead of the real clock: the calendar file never carries an event before today.
const ahead = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
function task(id: string): TimelineItem {
	const def: TaskDef = {
		id,
		title: id,
		category: 'admin',
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -30,
		windowEnd: 0,
		why: ''
	};
	return {
		def,
		targetDate: ahead,
		windowStartDate: ahead,
		windowEndDate: ahead,
		status: 'start-now',
		aimDate: ahead
	};
}
const missing = (id: string): DesiredEvent => ({
	taskId: id,
	moment: 'aim',
	title: `Aim for: ${id}`,
	isoDate: ahead,
	alarmDays: []
});
// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};

function props(over: Partial<{ missing: DesiredEvent[]; onAdd: (f: CalendarFile) => void }> = {}) {
	return {
		items: [task('old'), task('new'), task('newer')],
		exclusions: { taskIds: [], categories: [] },
		access: 'ready' as const,
		stale: [],
		onAcknowledge: async () => {},
		onSetExclusions: vi.fn(),
		onAdd: vi.fn(),
		...over
	};
}

beforeEach(() => {
	seams.gate = null;
});

describe('CalendarPanel, with events the calendar is missing', () => {
	it('says how many, and offers to add only those', async () => {
		const { container } = await render(CalendarPanel, {
			props: props({ missing: [missing('new'), missing('newer')] })
		});
		expect(container.textContent).toContain('Your calendar is missing 2 new events.');
		await expect.element(page.getByRole('button', { name: 'Add the new ones' })).toBeVisible();
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	it('says one event in the singular', async () => {
		const { container } = await render(CalendarPanel, {
			props: props({ missing: [missing('new')] })
		});
		expect(container.textContent).toContain('Your calendar is missing 1 new event.');
	});

	it.each([
		['nothing is missing', props({ missing: [] })],
		[
			'the stores are still loading',
			{ ...props({ missing: [missing('new')] }), access: 'loading' as const }
		]
	])('shows no line or button when %s', async (_, p) => {
		const { container } = await render(CalendarPanel, { props: p });
		expect(container.textContent).not.toContain('Your calendar is missing');
		expect(page.getByRole('button', { name: 'Add the new ones' }).query()).toBeNull();
	});

	it('hands over a file of the missing events only', async () => {
		const onAdd = vi.fn();
		await render(CalendarPanel, { props: props({ missing: [missing('new')], onAdd }) });
		await page.getByRole('button', { name: 'Add the new ones' }).click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		const file = onAdd.mock.calls[0]?.[0] as CalendarFile;
		expect(file.events.map((e) => e.taskId)).toEqual(['new']);
		expect(file.ics).toContain('SUMMARY:Aim for: new');
		expect(file.ics).not.toContain('SUMMARY:Aim for: old');
	});

	// The button goes once the page records the add; focus goes to the next thing to press, not the top of the page.
	it('moves focus to Add to my calendar once the add is recorded', async () => {
		const p = props({
			missing: [missing('new')],
			onAdd: () => void screen.rerender({ ...p, missing: [] })
		});
		const screen = await render(CalendarPanel, { props: p });
		await page.getByRole('button', { name: 'Add the new ones' }).click();
		await expect.element(page.getByRole('button', { name: /^add to my calendar$/i })).toHaveFocus();
	});

	// A held key repeats about every 40 ms. Once the add is recorded the button hands focus to Add as it goes; when the
	// record fails it stays. Either way a repeat must reach neither button: each would make and hand over another file.
	it.each([
		['builds at once and is recorded', 0, true],
		['takes a while to build and is recorded', 100, true],
		['builds at once and is not recorded', 0, false],
		['takes a while to build and is not recorded', 100, false]
	] as const)(
		'makes one file for a held Enter on Add the new ones when the file %s',
		async (_, ms, recorded) => {
			const onAdd = vi.fn();
			const p = props({
				missing: [missing('new')],
				onAdd: (f) => {
					onAdd(f);
					if (recorded) void screen.rerender({ ...p, missing: [] });
				}
			});
			const screen = await render(CalendarPanel, { props: p });
			(screen.container.querySelector('.cal-new__add') as HTMLButtonElement).focus();
			if (ms) seams.gate = new Promise<void>((resolve) => setTimeout(resolve, ms));
			const session = cdp();
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
			for (let i = 0; i < 15; i++) {
				await new Promise((resolve) => setTimeout(resolve, 40));
				await session.send('Input.dispatchKeyEvent', {
					type: 'keyDown',
					autoRepeat: true,
					...ENTER
				});
			}
			await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(onAdd).toHaveBeenCalledOnce();
		}
	);
});
