import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import StaleEvents from './StaleEvents.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';
import type { HandedOverEvent } from '$lib/calendar/types';

// Two adds on different days, the later one first: only the earliest add date is "since you added it".
const E: HandedOverEvent[] = [
	{
		taskId: 'tap-capstone',
		moment: 'last',
		title: 'Last day: Complete your TAP Capstone',
		isoDate: '2027-01-30',
		addedOn: '2026-10-05'
	},
	{
		taskId: 'tap-course',
		moment: 'aim',
		title: 'Aim for: Attend your required TAP curriculum',
		isoDate: '2026-12-31',
		addedOn: '2026-10-03'
	}
];

describe('StaleEvents', () => {
	it('lists each event by its old title and date, from the earliest add', async () => {
		render(StaleEvents, { props: { events: E, onAcknowledge: vi.fn(async () => {}) } });
		await expect.element(page.getByText('Your calendar is out of date')).toBeVisible();
		await expect
			.element(
				page.getByText(
					/Since you added it on Oct 3, these changed\. Delete them from your calendar, then add again:/
				)
			)
			.toBeVisible();
		await expect.element(page.getByText('Last day: Complete your TAP Capstone')).toBeVisible();
		await expect.element(page.getByText('Jan 30, 2027')).toBeVisible();
	});

	// A screen reader moving by heading finds the box, and the button names what it confirms.
	it('heads the box, and describes its button by the heading and the lead', async () => {
		render(StaleEvents, { props: { events: E, onAcknowledge: vi.fn(async () => {}) } });
		await expect
			.element(page.getByRole('heading', { level: 3, name: 'Your calendar is out of date' }))
			.toBeVisible();
		await expect
			.element(page.getByRole('button', { name: "I've deleted these" }))
			.toHaveAccessibleDescription(
				/^Your calendar is out of date Since you added it on Oct 3, these changed\./
			);
	});

	it("clears through I've deleted these", async () => {
		const onAcknowledge = vi.fn(async () => {});
		render(StaleEvents, { props: { events: E, onAcknowledge } });
		await page.getByRole('button', { name: "I've deleted these" }).click();
		expect(onAcknowledge).toHaveBeenCalledOnce();
	});

	it('says so when the save fails, and keeps the list', async () => {
		const onAcknowledge = vi.fn(async () => Promise.reject(new Error('E_TEST_SAVE')));
		render(StaleEvents, { props: { events: E, onAcknowledge } });
		await page.getByRole('button', { name: "I've deleted these" }).click();
		await expect
			.element(page.getByText('Could not update right now - please try again.'))
			.toBeVisible();
		await expect.element(page.getByText('Last day: Complete your TAP Capstone')).toBeVisible();
	});

	it('takes the failure line away when the user tries again', async () => {
		const onAcknowledge = vi
			.fn<() => Promise<void>>()
			.mockRejectedValueOnce(new Error('E_TEST_SAVE'))
			.mockImplementationOnce(() => new Promise<void>(() => {}));
		render(StaleEvents, { props: { events: E, onAcknowledge } });
		const ack = page.getByRole('button', { name: "I've deleted these" });
		await ack.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		await ack.click();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	it('draws nothing with nothing to list', () => {
		const { container } = render(StaleEvents, {
			props: { events: [], onAcknowledge: vi.fn(async () => {}) }
		});
		expect(container.textContent?.trim()).toBe('');
	});

	it('says nothing personal', () => {
		const { container } = render(StaleEvents, {
			props: { events: E, onAcknowledge: vi.fn(async () => {}) }
		});
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});
});

// Component tests run without app.css, so the cases set the tokens the list uses and give it the width the Settings
// calendar panel gives it on a 320 px phone (222 px, measured on the build). The tokens and the frame's size are put
// back after each case.
describe('StaleEvents (layout by width)', () => {
	const TOKENS: Record<string, string> = {
		'--space-xs': '4px',
		'--space-s': '8px',
		'--space-m': '16px',
		'--space-l': '24px',
		'--font-size-s': '14px'
	};
	const PHONE_LIST_WIDTH = '222px';
	// Real titles from a SkillBridge date's list, each beside the date the user looks for in their calendar.
	const LONG: HandedOverEvent[] = [
		'Aim for: Verify your service record is accurate (awards, training)',
		'Aim for: Start documenting any medical conditions',
		'Aim for: Attend your required TAP curriculum',
		'Before you leave: Review your DD-2648 and DD-214 for accuracy'
	].map((title, i) => ({
		taskId: `t${i}`,
		moment: 'aim',
		title,
		isoDate: '2026-11-01',
		addedOn: '2026-10-05'
	}));
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
	const phoneList = async () => {
		await page.viewport(320, 800);
		const { container } = render(StaleEvents, {
			props: { events: LONG, onAcknowledge: vi.fn(async () => {}) }
		});
		container.style.width = PHONE_LIST_WIDTH;
		container.style.fontFamily = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
		container.style.lineHeight = '1.5';
		return container;
	};

	// Text widths differ a little between browsers, so one width may happen to fit every date. The sweep covers the
	// list's width on every phone from 320 to 375 px wide (222 to 277 px), where some title ends too close to the
	// edge for its date.
	it('on phone widths each date stays whole, taking the next line when it does not fit', async () => {
		const container = await phoneList();
		const dates = [...container.querySelectorAll('.stale__date')];
		const lines = (el: Element) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return [...range.getClientRects()].filter((rect) => rect.width > 0);
		};
		const startsALine = (date: Element) => {
			const item = date.parentElement?.getBoundingClientRect();
			return item !== undefined && Math.abs(date.getBoundingClientRect().left - item.left) < 1;
		};
		let moved = 0;
		for (let width = 222; width <= 277; width++) {
			container.style.width = `${width}px`;
			for (const date of dates) {
				expect(lines(date), `${width} px: ${date.textContent ?? ''}`).toHaveLength(1);
				if (startsALine(date)) moved++;
			}
		}
		// The case is reached: somewhere in the sweep a date did not fit after its title.
		expect(moved).toBeGreaterThan(0);
	});

	it("on a 320 px phone the I've deleted these button is a 44 px target", async () => {
		const container = await phoneList();
		const button = container.querySelector('.stale__ack') as HTMLElement;
		expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
	});
});
