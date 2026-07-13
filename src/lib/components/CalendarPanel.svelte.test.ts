import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import CalendarPanel from './CalendarPanel.svelte';
import type { TimelineItem } from '$lib/timeline/generate';
import type { TaskDef } from '$lib/timeline/types';

function def(id: string, category: TaskDef['category']): TaskDef {
	return {
		id,
		title: id,
		category,
		track: 'transition',
		windowStart: -30,
		windowEnd: 0,
		why: '',
		value: ''
	};
}
function item(d: TaskDef): TimelineItem {
	return {
		def: d,
		targetDate: '2026-08-14',
		windowStartDate: '2026-08-14',
		windowEndDate: '2026-08-14',
		status: 'start-now'
	};
}

describe('CalendarPanel', () => {
	it('downloads an .ics of the pending, non-excluded items when "Add to calendar" is clicked', async () => {
		const onDownload = vi.fn();
		const items = [item(def('a', 'admin')), item(def('m', 'medical'))];
		const { container } = render(CalendarPanel, {
			props: {
				items,
				exclusions: { taskIds: [], categories: ['medical'] },
				onSetExclusions: vi.fn(),
				onDownload
			}
		});
		(container.querySelector('.cal-add') as HTMLButtonElement).click();
		// addToCalendar awaits computeIcsUid (crypto.subtle) per event, so poll for the callback.
		await vi.waitFor(() => expect(onDownload).toHaveBeenCalledOnce());
		const ics = onDownload.mock.calls[0]?.[0] as string;
		expect(ics).toContain('SUMMARY:a'); // pending admin task included
		expect(ics).not.toContain('SUMMARY:m'); // medical excluded -> no event
	});

	it('keeps the category toggles collapsed until "Customize" is expanded (inline, matches the snooze date-adjust)', () => {
		const { container } = render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				onSetExclusions: vi.fn(),
				onDownload: vi.fn()
			}
		});
		expect(container.querySelector('input[value="medical"]')).toBeNull(); // collapsed by default
		(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
		flushSync();
		expect(container.querySelector('input[value="medical"]')).not.toBeNull(); // expanded in place
	});

	it('toggling a category once expanded calls onSetExclusions with the updated set', () => {
		const onSetExclusions = vi.fn();
		const { container } = render(CalendarPanel, {
			props: {
				items: [item(def('a', 'admin'))],
				exclusions: { taskIds: [], categories: [] },
				onSetExclusions,
				onDownload: vi.fn()
			}
		});
		(container.querySelector('.cal-customize__toggle') as HTMLButtonElement).click();
		flushSync();
		(container.querySelector('input[value="medical"]') as HTMLInputElement).click();
		flushSync();
		expect(onSetExclusions).toHaveBeenCalledWith({ taskIds: [], categories: ['medical'] });
	});
});
