import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import CalendarCard from './CalendarCard.svelte';
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
		expect(ics).toContain('SUMMARY:a'); // the card honours the same exclusions as the panel
		expect(ics).not.toContain('SUMMARY:m');
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
});
