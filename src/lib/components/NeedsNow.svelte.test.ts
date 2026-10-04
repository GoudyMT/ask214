import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { page } from 'vitest/browser';
import NeedsNow from './NeedsNow.svelte';
import type { TimelineItem } from '$lib/timeline';
import type { NeedsNowGroups } from '$lib/timeline/needs-now';

function item(id: string, title: string, extra: Partial<TimelineItem> = {}): TimelineItem {
	return {
		def: {
			id,
			title,
			category: 'benefits',
			track: 'transition',
			kind: 'closes',
			windowStart: -180,
			windowEnd: -90,
			why: '',
			afterNote: 'n'
		},
		targetDate: '2026-09-01',
		windowStartDate: '2026-07-22',
		windowEndDate: '2026-10-20',
		status: 'closing-soon',
		...extra
	};
}
const empty: NeedsNowGroups = { late: [], closingSoon: [], justClosed: [], justOpened: [] };

describe('NeedsNow', () => {
	it('renders nothing when no task needs attention', () => {
		const { container } = render(NeedsNow, { props: { groups: empty } });
		expect(container.querySelector('section')).toBeNull();
	});

	it('shows the count, only the non-empty groups, and rows that link to their cards', () => {
		const groups: NeedsNowGroups = {
			...empty,
			closingSoon: [item('bdd', 'File your VA claim through BDD', { daysLeft: 17 })],
			justOpened: [
				item('pkg', 'Submit your separation package', {
					status: 'start-now',
					windowEndDate: '2026-11-19'
				})
			]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		expect(container.querySelector('h2')?.textContent).toContain('Needs you now');
		expect(container.querySelector('.needs-now__count')?.textContent).toBe('2');
		expect([...container.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
			'Closing soon',
			'Just opened'
		]);
		const rows = [...container.querySelectorAll('a.needs-now__row')];
		expect(rows.map((a) => a.getAttribute('href'))).toEqual(['#task-bdd', '#task-pkg']);
		expect(rows[0]?.textContent).toContain('Oct 20, 2026 - 17 days');
		expect(rows[1]?.textContent).toContain('open to Nov 19, 2026');
	});

	it('says when a late task was due and when a closed one closed', () => {
		const groups: NeedsNowGroups = {
			...empty,
			late: [item('cap', 'Complete your TAP Capstone', { status: 'late' })],
			justClosed: [item('bdd', 'File your VA claim through BDD', { status: 'closed' })]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		const rows = [...container.querySelectorAll('a.needs-now__row')];
		expect(rows[0]?.textContent).toContain('was due Oct 20, 2026');
		expect(rows[1]?.textContent).toContain('closed Oct 20, 2026');
	});

	it('counts a changed task down to its final day, and says "1 day" in the singular', () => {
		const groups: NeedsNowGroups = {
			...empty,
			closingSoon: [
				item('vgli', 'Convert your SGLI to VGLI', {
					status: 'changed',
					windowEndDate: '2027-09-15',
					finalEndDate: '2028-05-17',
					daysLeft: 30
				}),
				item('bdd', 'File your VA claim through BDD', { daysLeft: 1 })
			]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		const rows = [...container.querySelectorAll('a.needs-now__row')];
		expect(rows[0]?.textContent).toContain('May 17, 2028 - 30 days');
		expect(rows[1]?.textContent).toContain('Oct 20, 2026 - 1 day');
		expect(rows[1]?.textContent).not.toContain('1 days');
	});

	it('says today, not 0 days, on a last day - the same words as the task card', () => {
		const groups: NeedsNowGroups = {
			...empty,
			closingSoon: [item('bdd', 'File your VA claim through BDD', { daysLeft: 0 })]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		const row = container.querySelector('a.needs-now__row')?.textContent ?? '';
		expect(row).toContain('Oct 20, 2026 - today');
		expect(row).not.toContain('0 days');
	});

	it('says a two-edge task closed on its final day', () => {
		const groups: NeedsNowGroups = {
			...empty,
			justClosed: [
				item('vgli', 'Convert your SGLI to VGLI', {
					status: 'closed',
					windowEndDate: '2027-09-15',
					finalEndDate: '2028-05-17'
				})
			]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		expect(container.querySelector('a.needs-now__row')?.textContent).toContain(
			'closed May 17, 2028'
		);
	});

	it('orders the groups by urgency, counts every task, and marks only the time-bound dates', () => {
		const groups: NeedsNowGroups = {
			late: [item('cap', 'Complete your TAP Capstone', { status: 'late' })],
			closingSoon: [
				item('bdd', 'File your VA claim through BDD', { daysLeft: 17 }),
				item('sha', 'Complete your SHA', { daysLeft: 17 })
			],
			justClosed: [item('tri', 'Choose your health coverage', { status: 'closed' })],
			justOpened: [item('pkg', 'Submit your separation package', { status: 'start-now' })]
		};
		const { container } = render(NeedsNow, { props: { groups } });
		expect([...container.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
			'Late',
			'Closing soon',
			'Just closed',
			'Just opened'
		]);
		expect(container.querySelector('.needs-now__count')?.textContent).toBe('5');
		const hot = [...container.querySelectorAll('.needs-now__when')].map((el) =>
			el.classList.contains('needs-now__when--hot')
		);
		expect(hot).toEqual([true, true, true, true, false]);
	});
});

// On a phone a long title and the date do not fit side by side, so the date drops under the title instead of
// squeezing it into a narrow column. Component tests run without app.css, so the cases set the app's spacing
// tokens and give the panel the page's content width on a 320 px phone (16 px gutters): its rows then get the
// width they get in the app. The frame's size and the tokens are put back after each case.
describe('NeedsNow (layout by width)', () => {
	const SPACING: Record<string, string> = {
		'--space-xs': '4px',
		'--space-s': '8px',
		'--space-m': '16px',
		'--space-l': '24px'
	};
	const PHONE_CONTENT_WIDTH = '288px';
	let size = { width: 0, height: 0 };
	beforeEach(() => {
		size = { width: window.innerWidth, height: window.innerHeight };
		for (const [name, value] of Object.entries(SPACING)) {
			document.documentElement.style.setProperty(name, value);
		}
	});
	afterEach(async () => {
		for (const name of Object.keys(SPACING)) document.documentElement.style.removeProperty(name);
		await page.viewport(size.width, size.height);
	});

	const groups: NeedsNowGroups = {
		...empty,
		closingSoon: [
			item(
				'sha',
				'Complete your SHA (physical, dental, audiogram) and the Part A self-assessment',
				{
					daysLeft: 17
				}
			)
		]
	};
	const box = (container: Element, selector: string) =>
		(container.querySelector(selector) as HTMLElement).getBoundingClientRect();

	it('on a 320 px phone the date sits under a long title', async () => {
		await page.viewport(320, 800);
		const { container } = render(NeedsNow, { props: { groups } });
		container.style.width = PHONE_CONTENT_WIDTH;
		expect(box(container, '.needs-now__when').top).toBeGreaterThanOrEqual(
			box(container, '.needs-now__title').bottom
		);
	});

	it('on a wide screen the date sits on the same line as the title', async () => {
		await page.viewport(1024, 800);
		const { container } = render(NeedsNow, { props: { groups } });
		expect(box(container, '.needs-now__when').top).toBeLessThan(
			box(container, '.needs-now__title').bottom
		);
	});
});
