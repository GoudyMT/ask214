import { render } from 'vitest-browser-svelte';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import CalendarPanel from './CalendarPanel.svelte';
import '../../app.css';
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

	// A reader moving from button to button hears what "the new ones" are.
	it('describes Add the new ones by the count line', async () => {
		await render(CalendarPanel, { props: props({ missing: [missing('new')] }) });
		await expect
			.element(page.getByRole('button', { name: 'Add the new ones' }))
			.toHaveAccessibleDescription('Your calendar is missing 1 new event.');
	});

	// Once the old copies are deleted, the new versions are exactly what is left to add: Add the new ones adds them
	// without a second copy of every other event.
	it("moves focus to Add the new ones once I've deleted these saves", async () => {
		const old = { ...missing('new'), isoDate: ahead, addedOn: ahead };
		const p = {
			...props({ missing: [missing('new')] }),
			stale: [old],
			onAcknowledge: async () => {
				await screen.rerender({ ...p, stale: [] });
			}
		};
		const screen = await render(CalendarPanel, { props: p });
		await page.getByRole('button', { name: "I've deleted these" }).click();
		await expect.element(page.getByRole('button', { name: 'Add the new ones' })).toHaveFocus();
	});

	// The line sits in a status region from the start, so a screen reader hears it when the count appears or changes.
	it('announces the count when it changes', async () => {
		const p = props({ missing: [missing('new')] });
		const screen = await render(CalendarPanel, { props: p });
		const region = page.getByRole('status').element();
		expect(region.textContent?.trim()).toBe('Your calendar is missing 1 new event.');
		await screen.rerender({ ...p, missing: [missing('new'), missing('newer')] });
		await expect.poll(() => page.getByRole('status').element()).toBe(region);
		expect(region.textContent?.trim()).toBe('Your calendar is missing 2 new events.');
	});

	// Once the file is handed over the count goes; the same region says what happened and what is left to do, which is
	// the member's own tap in their calendar app.
	it('says the new events are in the file once it is handed over', async () => {
		const onAdd = vi.fn();
		const { container } = await render(CalendarPanel, {
			props: props({ missing: [missing('new')], onAdd })
		});
		const region = page.getByRole('status').element();
		await page.getByRole('button', { name: 'Add the new ones' }).click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		await expect
			.poll(() => region.textContent?.trim())
			.toBe('The new events are in the file. Add them in your calendar app.');
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	it('shows no line or button when nothing is missing', async () => {
		const { container } = await render(CalendarPanel, { props: props({ missing: [] }) });
		expect(container.textContent).not.toContain('Your calendar is missing');
		const region = page.getByRole('status').element();
		expect(region.textContent?.trim()).toBe('');
		// The empty region keeps no room: the panel looks as it did before it had one.
		expect(getComputedStyle(region).marginBottom).toBe('0px');
		expect(page.getByRole('button', { name: 'Add the new ones' }).query()).toBeNull();
	});

	// A firm step has two moments; the calendar may hold one already, and the file must not carry it again.
	it('hands over a file of the missing events only, moment by moment', async () => {
		const later = new Date(Date.now() + 80 * 86_400_000).toISOString().slice(0, 10);
		const firm: TimelineItem = {
			...task('firm'),
			def: { ...task('firm').def, kind: 'closes', afterNote: 'n' },
			status: 'upcoming',
			windowEndDate: later
		};
		const onAdd = vi.fn();
		await render(CalendarPanel, {
			props: {
				...props({ onAdd }),
				items: [task('old'), firm],
				missing: [{ ...missing('firm'), moment: 'opens', title: 'Opens: firm' }]
			}
		});
		await page.getByRole('button', { name: 'Add the new ones' }).click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		const file = onAdd.mock.calls[0]?.[0] as CalendarFile;
		expect(file.events.map((e) => `${e.taskId}|${e.moment}`)).toEqual(['firm|opens']);
		expect(file.ics).not.toContain('SUMMARY:Aim for: old');
	});

	// The record can fail to save (a relock as the phone's app chooser opens): the events still reached the member, so
	// the line must not offer them again, and a second press must make no second file.
	it('takes the line away once the file is handed over, even when the record is not saved', async () => {
		const onAdd = vi.fn();
		const { container } = await render(CalendarPanel, {
			props: props({ missing: [missing('new')], onAdd })
		});
		const button = page.getByRole('button', { name: 'Add the new ones' });
		await button.click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		await expect.element(button).not.toBeInTheDocument();
		expect(container.textContent).not.toContain('Your calendar is missing');
		await expect.element(page.getByRole('button', { name: /^add to my calendar$/i })).toHaveFocus();
	});

	it('makes one file for a double press before the record lands', async () => {
		const onAdd = vi.fn();
		await render(CalendarPanel, { props: props({ missing: [missing('new')], onAdd }) });
		const button = page
			.getByRole('button', { name: 'Add the new ones' })
			.element() as HTMLButtonElement;
		button.click();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		if (button.isConnected) button.click();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(onAdd).toHaveBeenCalledOnce();
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

	// Another tab's add, recorded here, takes the button away while a keyboard user sits on it without pressing: focus
	// goes to the next thing to press, not the top of the page.
	it('moves focus to Add to my calendar when the button goes while focused but not pressed', async () => {
		const p = props({ missing: [missing('new')] });
		const screen = await render(CalendarPanel, { props: p });
		(screen.container.querySelector('.cal-new__add') as HTMLButtonElement).focus();
		await screen.rerender({ ...p, missing: [] });
		await expect.element(page.getByRole('button', { name: /^add to my calendar$/i })).toHaveFocus();
	});

	// Add is found by its class in older tests; the new button must not answer to it, or they would press the wrong one.
	it('gives Add the new ones a class of its own', async () => {
		const { container } = await render(CalendarPanel, {
			props: props({ missing: [missing('new')] })
		});
		expect(container.querySelectorAll('.cal-add')).toHaveLength(1);
		expect(container.querySelector('.cal-add')?.textContent?.trim()).toBe('Add to my calendar');
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
			// Focus went to the next button, never to the page: a disabled button while it built would drop it.
			expect(document.activeElement?.textContent?.trim()).toBe('Add to my calendar');
		}
	);
});

describe('CalendarPanel, pressed while a category save runs', () => {
	// A member keeps a category off and presses Add before the save lands: the file must leave that category out, as
	// the box now shows, not carry it from the older choices.
	it.each([
		['Add to my calendar', [] as DesiredEvent[]],
		['Add the new ones', [missing('old'), missing('career')]]
	])('%s builds from the choices being saved', async (name, gaps) => {
		const career: TimelineItem = {
			...task('career'),
			def: { ...task('career').def, category: 'career' }
		};
		const onAdd = vi.fn();
		let land = () => {};
		const p = {
			...props({ missing: gaps, onAdd }),
			items: [task('old'), career],
			onSetExclusions: () =>
				new Promise<void>((done) => {
					land = () => {
						void screen
							.rerender({ ...p, exclusions: { taskIds: [], categories: ['admin'] } })
							.then(done);
					};
				})
		};
		const screen = await render(CalendarPanel, { props: p });
		await page.getByRole('button', { name: /customize/i }).click();
		await page.getByRole('checkbox', { name: 'admin' }).click();
		(page.getByRole('button', { name }).element() as HTMLButtonElement).click();
		await new Promise((resolve) => setTimeout(resolve, 50));
		land();
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		const file = onAdd.mock.calls[0]?.[0] as CalendarFile;
		expect(file.events.map((e) => e.taskId)).toEqual(['career']);
	});

	// The save fails and the saved choices cannot be read back: the panel stops being ready with a stand-in empty set.
	// A file built from it would carry the categories the member keeps off, medical ones among them.
	it('hands over nothing when the save leaves the choices unknown', async () => {
		const onAdd = vi.fn();
		let land = () => {};
		const p = {
			...props({ onAdd }),
			exclusions: { taskIds: [], categories: ['career' as const] },
			onSetExclusions: () =>
				new Promise<void>((_, fail) => {
					land = () => {
						void screen
							.rerender({
								...p,
								access: 'calendar-failed',
								exclusions: { taskIds: [], categories: [] }
							})
							.then(() => fail(new Error('E_OCC_CONFLICT')));
					};
				})
		};
		const screen = await render(CalendarPanel, { props: p });
		await page.getByRole('button', { name: /customize/i }).click();
		await page.getByRole('checkbox', { name: 'admin' }).click();
		(
			page.getByRole('button', { name: /^add to my calendar$/i }).element() as HTMLButtonElement
		).click();
		await new Promise((resolve) => setTimeout(resolve, 50));
		land();
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(onAdd).not.toHaveBeenCalled();
	});
});
// The save keeps off the last category with new events: a file with nothing in it would open the calendar app on an
// empty import, which reads as a broken add.
it('hands over nothing when the save leaves no new event to add', async () => {
	const career: TimelineItem = {
		...task('career'),
		def: { ...task('career').def, category: 'career' }
	};
	const onAdd = vi.fn();
	let land = () => {};
	const p = {
		...props({ missing: [missing('career')], onAdd }),
		items: [task('old'), career],
		onSetExclusions: () =>
			new Promise<void>((done) => {
				land = () => {
					void screen
						.rerender({ ...p, missing: [], exclusions: { taskIds: [], categories: ['career'] } })
						.then(done);
				};
			})
	};
	const screen = await render(CalendarPanel, { props: p });
	await page.getByRole('button', { name: /customize/i }).click();
	await page.getByRole('checkbox', { name: 'career' }).click();
	(page.getByRole('button', { name: 'Add the new ones' }).element() as HTMLButtonElement).click();
	await new Promise((resolve) => setTimeout(resolve, 50));
	land();
	await new Promise((resolve) => setTimeout(resolve, 150));
	expect(onAdd).not.toHaveBeenCalled();
});
