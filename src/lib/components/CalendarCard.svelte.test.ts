import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import CalendarCard from './CalendarCard.svelte';
import type { TimelineItem } from '$lib/timeline/generate';
import type { TaskDef } from '$lib/timeline/types';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

function def(id: string, category: TaskDef['category']): TaskDef {
	return {
		id,
		title: id,
		category,
		track: 'transition',
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

describe('CalendarCard', () => {
	it('adds the pending, non-excluded deadlines in one tap (direct add)', async () => {
		const onDownload = vi.fn();
		const { container } = render(CalendarCard, {
			props: {
				items: [item(def('a', 'admin')), item(def('m', 'medical'))],
				exclusions: { taskIds: [], categories: ['medical'] },
				onDownload,
				onDismiss: vi.fn()
			}
		});
		(container.querySelector('.cal-card__add') as HTMLButtonElement).click();
		// buildIcs awaits computeIcsUid (crypto.subtle) per event, so poll for the callback.
		await vi.waitFor(() => expect(onDownload).toHaveBeenCalledOnce());
		const ics = onDownload.mock.calls[0]?.[0] as string;
		expect(ics).toContain('SUMMARY:Aim for: a'); // the card honours the same exclusions as the panel
		expect(ics).not.toContain('SUMMARY:Aim for: m');
		expect(container.textContent).toContain('On a computer:'); // the test browser is desktop Chromium
	});

	it('the dismiss control calls onDismiss', () => {
		const onDismiss = vi.fn();
		const { container } = render(CalendarCard, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				onDownload: vi.fn(),
				onDismiss
			}
		});
		(container.querySelector('.cal-card__dismiss') as HTMLButtonElement).click();
		flushSync();
		expect(onDismiss).toHaveBeenCalledOnce();
	});

	// 38 CFR 14.629: the card's own words make no personal claim (the sentences per device are checked with the
	// task data in task-defs.test.ts).
	it('adds no personal eligibility claim', () => {
		const { container } = render(CalendarCard, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				onDownload: vi.fn(),
				onDismiss: vi.fn()
			}
		});
		const text = textOf(container);
		expect(text).toContain('Add to my calendar');
		expect(makesPersonalClaim(text), text).toBe(false);
	});
});
