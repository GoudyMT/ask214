import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import GlanceRow from './GlanceRow.svelte';
import type { HomeRow } from '$lib/timeline/home-glance';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

// Each line exactly as the page holds it: a check that evened out the spacing passed a row reading "Your timeline-".
const lines = (container: Element) => [
	container.querySelector('.glance__name')?.textContent,
	container.querySelector('.glance__detail')?.textContent
];

const DUE: HomeRow = {
	name: 'Your timeline',
	count: '2 need you now',
	status: { word: 'Late', hot: true },
	detail: 'Complete Initial and Pre-separation Counseling'
};

describe('GlanceRow', () => {
	it('is one link holding the name, the count, the status word and the detail', async () => {
		const { container } = await render(GlanceRow, { props: { row: DUE, to: '/timeline' } });
		const links = container.querySelectorAll('a');
		expect(links).toHaveLength(1);
		const link = links[0]!;
		expect(link.getAttribute('href')).toBe('/timeline');
		expect(lines(link)).toEqual([
			'Your timeline - 2 need you now',
			'Late - Complete Initial and Pre-separation Counseling'
		]);
	});

	it('marks an urgent status word, and only an urgent one', async () => {
		const hot = (await render(GlanceRow, { props: { row: DUE, to: '/timeline' } })).container;
		expect(hot.querySelector('.glance__status--hot')?.textContent).toBe('Late');
		const calm = (
			await render(GlanceRow, {
				props: { row: { ...DUE, status: { word: 'Start now', hot: false } }, to: '/timeline' }
			})
		).container;
		expect(calm.querySelector('.glance__status')?.textContent).toBe('Start now');
		expect(calm.querySelector('.glance__status--hot')).toBeNull();
	});

	it('draws no stray separators when a row has no count or status', async () => {
		const { container } = await render(GlanceRow, {
			props: {
				row: { name: 'Your timeline', detail: 'Could not load it here - open the Timeline' },
				to: '/timeline'
			}
		});
		expect(lines(container)).toEqual([
			'Your timeline',
			'Could not load it here - open the Timeline'
		]);
		expect(container.querySelector('.glance__status')).toBeNull();
	});

	it('is at least 44 px tall, a full-width tap target', async () => {
		const { container } = await render(GlanceRow, { props: { row: DUE, to: '/timeline' } });
		const box = container.querySelector('a')!.getBoundingClientRect();
		expect(box.height).toBeGreaterThanOrEqual(44);
		expect(box.width).toBe(container.getBoundingClientRect().width);
	});

	it('makes no personal claim', async () => {
		const { container } = await render(GlanceRow, { props: { row: DUE, to: '/timeline' } });
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});
});
