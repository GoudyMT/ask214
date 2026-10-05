import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
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
