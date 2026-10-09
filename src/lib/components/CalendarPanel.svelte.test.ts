import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import CalendarPanel from './CalendarPanel.svelte';
import type { TimelineItem } from '$lib/timeline/generate';
import type { TaskDef } from '$lib/timeline/types';
import type { HandedOverEvent, TaskExclusions } from '$lib/calendar/types';
import type { CalendarFile } from '$lib/calendar/build-ics';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

function def(id: string, category: TaskDef['category']): TaskDef {
	return {
		id,
		title: id,
		category,
		finishBefore: 'separation',
		kind: 'soft',
		windowStart: -30,
		windowEnd: 0,
		why: ''
	};
}
// Dated ahead of the real clock: the calendar file never carries an event before today.
const ahead = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);
function item(d: TaskDef): TimelineItem {
	return {
		def: d,
		targetDate: ahead,
		windowStartDate: ahead,
		windowEndDate: ahead,
		status: 'start-now',
		aimDate: ahead
	};
}
// No add recorded yet: the panel as it was before the record existed.
const NO_RECORD: {
	stale: HandedOverEvent[];
	onAcknowledge: () => Promise<void>;
} = { stale: [], onAcknowledge: async () => {} };

describe('CalendarPanel', () => {
	it('downloads an .ics of the pending, non-excluded items when "Add to calendar" is clicked', async () => {
		const onAdd = vi.fn();
		const items = [item(def('a', 'admin')), item(def('m', 'medical'))];
		const { container } = await render(CalendarPanel, {
			props: {
				items,
				exclusions: { taskIds: [], categories: ['medical'] },
				ready: true,
				...NO_RECORD,
				onSetExclusions: vi.fn(),
				onAdd
			}
		});
		(container.querySelector('.cal-add') as HTMLButtonElement).click();
		// addToCalendar awaits computeIcsUid (crypto.subtle) per event, so poll for the callback.
		await vi.waitFor(() => expect(onAdd).toHaveBeenCalledOnce());
		const ics = (onAdd.mock.calls[0]?.[0] as CalendarFile | undefined)?.ics;
		expect(ics).toContain('SUMMARY:Aim for: a'); // pending admin task included
		expect(ics).not.toContain('SUMMARY:Aim for: m'); // medical excluded -> no event
		expect(container.querySelector('.cal-add')?.textContent?.trim()).toBe('Add to my calendar');
		expect(container.textContent).toContain('On a computer:'); // the test browser is desktop Chromium
	});

	it('keeps the category toggles collapsed until "Customize" is expanded (inline, matches the snooze date-adjust)', async () => {
		const { container } = await render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				ready: true,
				...NO_RECORD,
				onSetExclusions: vi.fn(),
				onAdd: vi.fn()
			}
		});
		expect(container.querySelector('input[value="medical"]')).toBeNull(); // collapsed by default
		(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
		flushSync();
		expect(container.querySelector('input[value="medical"]')).not.toBeNull(); // expanded in place
	});

	it('fails closed when the store is not ready: no export against an unknown exclusion set', async () => {
		const onAdd = vi.fn();
		const { container } = await render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] }, // the empty DEFAULT, not a real record
				ready: false,
				...NO_RECORD,
				onSetExclusions: vi.fn(),
				onAdd
			}
		});
		// An unknown exclusion set must never be treated as "the user excluded nothing".
		expect((container.querySelector('.cal-add') as HTMLButtonElement).disabled).toBe(true);
		expect((container.querySelector('.cal-customize__toggle') as HTMLButtonElement).disabled).toBe(
			true
		);
		expect(container.textContent).toContain('could not be loaded');
		expect(onAdd).not.toHaveBeenCalled();
	});

	// While the settings are unknown the panel says only that; "Nothing ahead" would be a second, unproven reason.
	it('does not also say nothing is ahead while the settings are unknown', async () => {
		const passed: TimelineItem = {
			...item(def('p', 'admin')),
			windowEndDate: '2020-01-01',
			aimDate: '2020-01-01',
			status: 'still-to-do'
		};
		const { container } = await render(CalendarPanel, {
			props: {
				items: [passed],
				exclusions: { taskIds: [], categories: [] },
				ready: false,
				...NO_RECORD,
				onSetExclusions: vi.fn(),
				onAdd: vi.fn()
			}
		});
		expect(container.textContent).toContain('could not be loaded');
		expect(container.textContent).not.toContain('Nothing ahead');
	});

	// Today is the date on the device clock: on a US evening the UTC date is already tomorrow, and a task aimed for
	// today must still keep the add on.
	it('keeps the add on for a task aimed at today, on a US evening', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(new Date('2026-10-04T01:00:00Z'));
			expect(new Date().getDate()).toBe(3); // the test browser's zone took effect: 18:00 on Oct 3
			const today: TimelineItem = {
				...item(def('t', 'admin')),
				windowEndDate: '2026-10-03',
				aimDate: '2026-10-03'
			};
			const { container } = await render(CalendarPanel, {
				props: {
					items: [today],
					exclusions: { taskIds: [], categories: [] },
					ready: true,
					...NO_RECORD,
					onSetExclusions: vi.fn(),
					onAdd: vi.fn()
				}
			});
			expect((container.querySelector('.cal-add') as HTMLButtonElement).disabled).toBe(false);
			expect(container.textContent).not.toContain('Nothing ahead');
		} finally {
			vi.useRealTimers();
		}
	});

	// The file never carries an event before today, so with nothing ahead (or everything kept off) there is nothing
	// to add: the button stays off and says why, instead of handing over an empty file.
	it('with nothing ahead to add, keeps the button off and says so', async () => {
		const passed: TimelineItem = {
			...item(def('p', 'admin')),
			windowEndDate: '2020-01-01',
			aimDate: '2020-01-01',
			status: 'still-to-do'
		};
		const panel = async (items: TimelineItem[], categories: TaskDef['category'][]) =>
			(
				await render(CalendarPanel, {
					props: {
						items,
						exclusions: { taskIds: [], categories },
						ready: true,
						...NO_RECORD,
						onSetExclusions: vi.fn(),
						onAdd: vi.fn()
					}
				})
			).container;
		for (const container of [
			await panel([passed], []),
			await panel([item(def('a', 'admin'))], ['admin'])
		]) {
			expect((container.querySelector('.cal-add') as HTMLButtonElement).disabled).toBe(true);
			expect(container.textContent).toContain('Nothing ahead to add right now.');
		}
	});

	// Not every calendar app updates an event on a re-add, so after a date change the old events are the user's to
	// remove. Said wherever there is something to add, and only there.
	it('tells the user to remove old events after a date change, when there is something to add', async () => {
		const LINE = 'Changed a date? Remove the events you added before, then add again.';
		const panel = async (items: TimelineItem[]) =>
			(
				await render(CalendarPanel, {
					props: {
						items,
						exclusions: { taskIds: [], categories: [] },
						ready: true,
						...NO_RECORD,
						onSetExclusions: vi.fn(),
						onAdd: vi.fn()
					}
				})
			).container;
		expect((await panel([item(def('a', 'admin'))])).textContent).toContain(LINE);
		const passed: TimelineItem = {
			...item(def('p', 'admin')),
			windowEndDate: '2020-01-01',
			aimDate: '2020-01-01',
			status: 'still-to-do'
		};
		expect((await panel([passed])).textContent).not.toContain(LINE);
	});

	// The downloaded file outlives Erase all data, so wherever there is a file to add, the panel says it can go once
	// it is in the calendar: a line of its own, right after the steps for this device.
	it('says the downloaded file can be deleted once added, when there is something to add', async () => {
		const LINE = "Once it's added, you can delete the downloaded file.";
		const panel = async (items: TimelineItem[]) =>
			(
				await render(CalendarPanel, {
					props: {
						items,
						exclusions: { taskIds: [], categories: [] },
						ready: true,
						...NO_RECORD,
						onSetExclusions: vi.fn(),
						onAdd: vi.fn()
					}
				})
			).container;
		const lines = [
			...(await panel([item(def('a', 'admin'))])).querySelectorAll('.cal-hint--device')
		].map((p) => p.textContent?.trim());
		expect(lines[1]).toBe(LINE);
		const passed: TimelineItem = {
			...item(def('p', 'admin')),
			windowEndDate: '2020-01-01',
			aimDate: '2020-01-01',
			status: 'still-to-do'
		};
		expect((await panel([passed])).textContent).not.toContain(LINE);
	});

	it('toggling a category once expanded calls onSetExclusions with the updated set', async () => {
		const onSetExclusions = vi.fn();
		const { container } = await render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				ready: true,
				...NO_RECORD,
				onSetExclusions,
				onAdd: vi.fn()
			}
		});
		(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
		flushSync();
		(container.querySelector('input[value="medical"]') as HTMLInputElement).click();
		flushSync();
		// The panel sends an update for the set as saved; applied to it, medical is added.
		expect(onSetExclusions).toHaveBeenCalledOnce();
		const update = onSetExclusions.mock.calls[0]?.[0] as (
			current: TaskExclusions
		) => TaskExclusions;
		expect(update({ taskIds: [], categories: [] })).toEqual({
			taskIds: [],
			categories: ['medical']
		});
	});

	// The saved set reaches the panel only after the save lands, so two quick taps happen against the same, older
	// set. Each toggle must apply to the set as saved, in order (as the store does), or the second tap writes a
	// set without the first and that category goes back into the calendar file.
	it('keeps both of two quick toggles made before the first save lands', async () => {
		let saved: TaskExclusions = { taskIds: [], categories: [] };
		const onSetExclusions = async (
			next: TaskExclusions | ((current: TaskExclusions) => TaskExclusions)
		) => {
			saved = typeof next === 'function' ? next(saved) : next;
		};
		const { container } = await render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] }, // the save has not landed yet
				ready: true,
				...NO_RECORD,
				onSetExclusions,
				onAdd: vi.fn()
			}
		});
		(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
		flushSync();
		(container.querySelector('input[value="medical"]') as HTMLInputElement).click();
		(container.querySelector('input[value="admin"]') as HTMLInputElement).click();
		flushSync();
		expect(saved.categories).toEqual(['medical', 'admin']);
	});

	it('puts a category toggle back, and says so, when the save fails', async () => {
		await render(CalendarPanel, {
			props: {
				items: [],
				exclusions: { taskIds: [], categories: [] },
				ready: true,
				...NO_RECORD,
				onSetExclusions: () => Promise.reject(new Error('E_OCC_CONFLICT')),
				onAdd: () => {}
			}
		});
		await page.getByRole('button', { name: /customize what's included/i }).click();
		const box = page.getByRole('checkbox', { name: 'medical' });
		await box.click();
		await expect.element(box).not.toBeChecked();
		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
	});

	it('takes the failure line away once a later toggle saves', async () => {
		const onSetExclusions = vi
			.fn()
			.mockRejectedValueOnce(new Error('E_OCC_CONFLICT'))
			.mockResolvedValueOnce(undefined);
		await render(CalendarPanel, {
			props: {
				items: [],
				exclusions: { taskIds: [], categories: [] },
				ready: true,
				...NO_RECORD,
				onSetExclusions,
				onAdd: () => {}
			}
		});
		await page.getByRole('button', { name: /customize what's included/i }).click();
		await page.getByRole('checkbox', { name: 'medical' }).click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		await page.getByRole('checkbox', { name: 'admin' }).click();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	const HELD: HandedOverEvent = {
		taskId: 'tap-capstone',
		moment: 'last',
		title: 'Last day: Complete your TAP Capstone',
		isoDate: '2027-01-30',
		addedOn: '2026-10-03'
	};
	const withRecord = async (
		ready: boolean,
		stale: HandedOverEvent[],
		onAcknowledge = NO_RECORD.onAcknowledge
	) =>
		(
			await render(CalendarPanel, {
				props: {
					items: [item(def('a', 'admin'))],
					exclusions: { taskIds: [], categories: [] },
					ready,
					stale,
					onAcknowledge,
					onSetExclusions: vi.fn(),
					onAdd: vi.fn()
				}
			})
		).container;

	it('lists the events to delete above the Add button, once its settings are loaded', async () => {
		const container = await withRecord(true, [HELD]);
		const head = [...container.querySelectorAll('h3')].find(
			(h) => h.textContent === 'Your calendar is out of date'
		);
		const add = container.querySelector('.cal-add');
		expect(head).toBeDefined();
		expect(add).not.toBeNull();
		if (!head || !add) return;
		expect(head.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	// Until both stores load, the list would be built from a stand-in empty task state and could name an event
	// that is not out of date.
	it('shows no list while its settings are not loaded', async () => {
		expect((await withRecord(false, [HELD])).textContent).not.toContain(
			'Your calendar is out of date'
		);
	});

	// Nothing is listed while the settings load, so the general line stands, even when the list would name events.
	it('keeps the general line while its settings are not loaded', async () => {
		expect((await withRecord(false, [HELD])).textContent).toContain(
			'Changed a date? Remove the events you added before, then add again.'
		);
	});

	// Nothing listed - no add recorded yet, or every listed event acknowledged - leaves the general line, which also
	// says to add again; while the list names events, it replaces the line.
	it('shows the general line whenever nothing is listed, and the list in its place', async () => {
		const LINE = 'Changed a date? Remove the events you added before, then add again.';
		expect((await withRecord(true, [])).textContent).toContain(LINE);
		expect((await withRecord(true, [HELD])).textContent).not.toContain(LINE);
	});

	// The list unmounts with focus on its button; focus goes to the next step the list names, adding again. The rerender
	// is the page's own update: the saved record no longer holds the events, so the list goes.
	it("moves focus to the add button once I've deleted these saves", async () => {
		const props = {
			items: [item(def('a', 'admin'))],
			exclusions: { taskIds: [], categories: [] },
			ready: true,
			stale: [HELD],
			onSetExclusions: vi.fn(),
			onAdd: vi.fn(),
			onAcknowledge: async () => {
				await screen.rerender({ ...props, stale: [] });
			}
		};
		const screen = await render(CalendarPanel, { props });
		await page.getByRole('button', { name: "I've deleted these" }).click();
		await expect.element(page.getByRole('button', { name: /^add to my calendar$/i })).toHaveFocus();
	});

	// A user who moved on while the save ran stays where they are: focus moves only when it fell with the list.
	it('leaves focus where the user moved it while the save ran', async () => {
		let finish = (): Promise<void> => Promise.resolve();
		const props = {
			items: [item(def('a', 'admin'))],
			exclusions: { taskIds: [], categories: [] },
			ready: true,
			stale: [HELD],
			onSetExclusions: vi.fn(),
			onAdd: vi.fn(),
			onAcknowledge: () =>
				new Promise<void>((resolve) => {
					finish = async () => {
						await screen.rerender({ ...props, stale: [] });
						resolve();
					};
				})
		};
		const screen = await render(CalendarPanel, { props });
		await page.getByRole('button', { name: "I've deleted these" }).click();
		const toggle = page
			.getByRole('button', { name: /customize what's included/i })
			.element() as HTMLElement;
		toggle.focus();
		await finish();
		// Past the panel's own tick and focus step, so a move it made would have landed.
		await new Promise((r) => setTimeout(r, 50));
		expect(document.activeElement).toBe(toggle);
	});

	// The move does not scroll: the reader may have scrolled on while the save ran.
	it('moves focus to the add button without scrolling the page', async () => {
		let finish = (): Promise<void> => Promise.resolve();
		const props = {
			items: [item(def('a', 'admin'))],
			exclusions: { taskIds: [], categories: [] },
			ready: true,
			stale: [HELD],
			onSetExclusions: vi.fn(),
			onAdd: vi.fn(),
			onAcknowledge: () =>
				new Promise<void>((resolve) => {
					finish = async () => {
						await screen.rerender({ ...props, stale: [] });
						resolve();
					};
				})
		};
		const screen = await render(CalendarPanel, { props });
		// The panel sits below a tall block and the reader scrolls back to the top, so the panel is out of view and the
		// list going away below it shifts nothing on screen; only a focus move that scrolls would change the position.
		const spacer = document.createElement('div');
		spacer.style.height = '5000px';
		document.body.prepend(spacer);
		try {
			await page.getByRole('button', { name: "I've deleted these" }).click();
			window.scrollTo(0, 0);
			await finish();
			await expect
				.element(page.getByRole('button', { name: /^add to my calendar$/i }))
				.toHaveFocus();
			expect(window.scrollY).toBe(0);
		} finally {
			spacer.remove();
			window.scrollTo(0, 0);
		}
	});

	// With nothing ahead to add, Add is off and cannot take focus, so the Calendar heading takes it. The rerender is the
	// page's own update: the saved record no longer holds the events, so the list goes.
	it('moves focus to the Calendar heading when the list clears with nothing to add', async () => {
		const props = {
			items: [],
			exclusions: { taskIds: [], categories: [] },
			ready: true,
			stale: [HELD],
			onSetExclusions: vi.fn(),
			onAdd: vi.fn(),
			onAcknowledge: async () => {
				await screen.rerender({ ...props, stale: [] });
			}
		};
		const screen = await render(CalendarPanel, { props });
		// The ring's colour token is set as the app defines it, so a ring drawn here would be a solid outline.
		document.documentElement.style.setProperty('--color-accent', '#1a66c2');
		try {
			await page.getByRole('button', { name: "I've deleted these" }).click();
			const heading = page.getByRole('heading', { level: 2, name: 'Calendar' });
			await expect.element(heading).toHaveFocus();
			// Focus that follows a click shows no ring: the rule is :focus-visible, which a pointer does not raise.
			expect(getComputedStyle(heading.element()).outlineStyle).not.toBe('solid');
		} finally {
			document.documentElement.style.removeProperty('--color-accent');
		}
	});

	// By keyboard the heading shows the app's focus ring - a 2 px solid outline with a 2 px gap, as on every button
	// and link - not the browser's own.
	it('rings the Calendar heading the way the app rings a button, when focus arrives by keyboard', async () => {
		const props = {
			items: [],
			exclusions: { taskIds: [], categories: [] },
			ready: true,
			stale: [HELD],
			onSetExclusions: vi.fn(),
			onAdd: vi.fn(),
			onAcknowledge: async () => {
				await screen.rerender({ ...props, stale: [] });
			}
		};
		const screen = await render(CalendarPanel, { props });
		// Component tests run without app.css; the ring's colour token is set here as the app defines it, and removed.
		document.documentElement.style.setProperty('--color-accent', '#1a66c2');
		try {
			(screen.container.querySelector('.stale__ack') as HTMLButtonElement).focus();
			await userEvent.keyboard('{Enter}');
			const heading = page.getByRole('heading', { level: 2, name: 'Calendar' });
			await expect.element(heading).toHaveFocus();
			const ring = getComputedStyle(heading.element());
			expect([ring.outlineStyle, ring.outlineWidth, ring.outlineOffset]).toEqual([
				'solid',
				'2px',
				'2px'
			]);
		} finally {
			document.documentElement.style.removeProperty('--color-accent');
		}
	});

	it("keeps focus on I've deleted these when the save fails", async () => {
		await withRecord(
			true,
			[HELD],
			vi.fn(async () => Promise.reject(new Error('E_TEST_SAVE')))
		);
		const ack = page.getByRole('button', { name: "I've deleted these" });
		await ack.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(ack).toHaveFocus();
	});

	it("passes I've deleted these to its handler", async () => {
		const onAcknowledge = vi.fn(async () => {});
		await withRecord(true, [HELD], onAcknowledge);
		await page.getByRole('button', { name: "I've deleted these" }).click();
		expect(onAcknowledge).toHaveBeenCalledOnce();
	});

	// 38 CFR 14.629: the panel's own words make no personal claim, with something to add, with nothing ahead, or
	// while its settings are unknown (the sentences per device are checked with the task data in task-defs.test.ts).
	it('adds no personal eligibility claim in any state', async () => {
		const passed: TimelineItem = {
			...item(def('p', 'admin')),
			windowEndDate: '2020-01-01',
			aimDate: '2020-01-01',
			status: 'still-to-do'
		};
		const states: { items: TimelineItem[]; ready: boolean }[] = [
			{ items: [item(def('a', 'admin'))], ready: true },
			{ items: [passed], ready: true },
			{ items: [item(def('a', 'admin'))], ready: false }
		];
		for (const { items, ready } of states) {
			const { container } = await render(CalendarPanel, {
				props: {
					items,
					exclusions: { taskIds: [], categories: [] },
					ready,
					...NO_RECORD,
					onSetExclusions: vi.fn(),
					onAdd: vi.fn()
				}
			});
			(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
			flushSync();
			const text = textOf(container);
			expect(makesPersonalClaim(text), text).toBe(false);
		}
	});
});

// The sentence under the button is chosen from this device's user agent; the test browser is desktop Chromium, so
// a phone and an iPad are stood in for by the two values the choice reads.
describe('CalendarPanel (the sentence for this device)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});
	const ANDROID =
		'Mozilla/5.0 (Linux; Android 16; SM-S941U) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36';
	const MAC =
		'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15';
	const panelProps = () => ({
		items: [item(def('a', 'admin'))],
		exclusions: { taskIds: [], categories: [] },
		ready: true,
		...NO_RECORD,
		onSetExclusions: vi.fn(),
		onAdd: vi.fn()
	});

	it('tells an Android phone what happens after the tap', async () => {
		vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(ANDROID);
		const { container } = await render(CalendarPanel, { props: panelProps() });
		expect(container.querySelector('.cal-hint--device')?.textContent).toContain('On this phone:');
	});

	it('reads an iPad, which asks for desktop pages, from its touch points', async () => {
		vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(MAC);
		vi.spyOn(Navigator.prototype, 'maxTouchPoints', 'get').mockReturnValue(5);
		const { container } = await render(CalendarPanel, { props: panelProps() });
		expect(container.querySelector('.cal-hint--device')?.textContent).toContain(
			'On iPhone or iPad'
		);
	});

	const IPHONE =
		'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1';
	const hintOf = (container: Element) =>
		container.querySelector('.cal-hint--device')?.textContent ?? '';

	it('never sends the installed iPhone app to Safari', async () => {
		vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(IPHONE);
		// An installed app answers yes to this one query and no to every other, so a check that asked the wrong
		// question would not pass.
		vi.spyOn(window, 'matchMedia').mockImplementation(
			(query) => ({ matches: query === '(display-mode: standalone)' }) as MediaQueryList
		);
		const hint = hintOf((await render(CalendarPanel, { props: panelProps() })).container);
		expect(hint).toContain('Open it from Downloads');
		expect(hint).not.toContain('Safari');
	});

	// The app installed from iPhone Safari does not report the display mode; it sets navigator.standalone instead.
	it('reads the installed iPhone app from navigator.standalone too', async () => {
		vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(IPHONE);
		Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
		try {
			const hint = hintOf((await render(CalendarPanel, { props: panelProps() })).container);
			expect(hint).toContain('Open it from Downloads');
			expect(hint).not.toContain('Safari');
		} finally {
			delete (navigator as Navigator & { standalone?: boolean }).standalone;
		}
	});

	// Chrome, Firefox and Edge on iPhone keep their own data, apart from Safari's, so they are not sent there
	// either. Safari in a browser tab still is: its data is the app's there.
	it('never sends another iPhone browser to Safari', async () => {
		const OTHER_BROWSERS = [
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15',
			'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/141.0.3537.71 Version/18.0 Mobile/15E148 Safari/604.1'
		];
		for (const userAgent of OTHER_BROWSERS) {
			vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(userAgent);
			const hint = hintOf((await render(CalendarPanel, { props: panelProps() })).container);
			expect(hint, userAgent).toContain('Open it from Downloads');
			expect(hint, userAgent).not.toContain('Safari');
			vi.restoreAllMocks();
		}
		vi.spyOn(Navigator.prototype, 'userAgent', 'get').mockReturnValue(IPHONE);
		expect(hintOf((await render(CalendarPanel, { props: panelProps() })).container)).toContain(
			'use Safari'
		);
	});
});

// On a narrow phone "Customize what's included" and its summary do not fit on one line. The label wraps with
// every line starting at the same edge, and the summary keeps one line, so the pair still reads as one row.
// Component tests run without app.css, so the cases set the app's spacing and type tokens and give the panel
// the width the Settings page gives it on a 320 px phone (272 px, measured on the build). The frame's size and
// the tokens are put back after each case.
describe('CalendarPanel (layout by width)', () => {
	const TOKENS: Record<string, string> = {
		'--space-s': '8px',
		'--space-m': '16px',
		'--space-l': '24px',
		'--font-size-s': '14px'
	};
	const SETTINGS_PANEL_WIDTH = '272px';
	let size = { width: 0, height: 0 };
	beforeEach(() => {
		size = { width: window.innerWidth, height: window.innerHeight };
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
	});
	afterEach(async () => {
		for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
		await page.viewport(size.width, size.height);
	});

	const props = () => ({
		items: [item(def('a', 'admin'))],
		exclusions: { taskIds: [], categories: [] },
		ready: true,
		...NO_RECORD,
		onSetExclusions: vi.fn(),
		onAdd: vi.fn()
	});
	// One rect per line of text the element's content takes.
	const lines = (el: Element) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		return [...range.getClientRects()].filter((rect) => rect.width > 0);
	};
	const label = (root: Element) =>
		root.querySelectorAll('.cal-customize__toggle > span')[1] as Element;
	const summary = (root: Element) => root.querySelector('.cal-customize__summary') as Element;

	it('on a 320 px phone the label wraps from one edge and the summary keeps one line', async () => {
		await page.viewport(320, 800);
		const { container } = await render(CalendarPanel, { props: props() });
		container.style.width = SETTINGS_PANEL_WIDTH;
		container.style.fontFamily = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
		container.style.lineHeight = '1.5';
		const labelLines = lines(label(container));
		// The case is reached: the row is too narrow for the label on one line.
		expect(labelLines.length).toBeGreaterThanOrEqual(2);
		for (const line of labelLines)
			expect(Math.abs(line.left - (labelLines[0]?.left ?? 0))).toBeLessThan(1);
		expect(lines(summary(container))).toHaveLength(1);
	});

	it('on a wide screen the label and the summary share one line', async () => {
		await page.viewport(1024, 800);
		const { container } = await render(CalendarPanel, { props: props() });
		const [labelLine] = lines(label(container));
		const summaryLines = lines(summary(container));
		expect(lines(label(container))).toHaveLength(1);
		expect(summaryLines).toHaveLength(1);
		expect(Math.abs((summaryLines[0]?.top ?? 0) - (labelLine?.top ?? 0))).toBeLessThan(1);
	});
});
