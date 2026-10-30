import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import { page } from 'vitest/browser';
import SourceList from './SourceList.svelte';
import type { SourcesIndex } from '#lib/sources/types.js';
import { SOURCES_INDEX } from '#lib/sources/sources-index.data.js';

const INDEX: SourcesIndex = {
	agency: [
		{ title: 'VA - Test Page', url: 'https://www.va.gov/test/', publisher: 'VA' },
		{ title: 'DoD - Test', url: 'https://www.militaryonesource.mil/test/', publisher: 'DoD' }
	],
	tapLibraryUrl: 'https://www.tapevents.mil/resources/documents',
	tapGuides: [
		{ title: 'TAP - Guide One', publisher: 'VA' },
		{ title: 'TAP - Guide Two', publisher: 'DoD' }
	],
	captured: { from: 'Jun 25, 2026', to: 'Sep 15, 2026' }
};

describe('SourceList', () => {
	it('renders both section headings', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const heads = [...container.querySelectorAll('h3')].map((h) => h.textContent ?? '');
		expect(heads.some((h) => /agency pages/i.test(h))).toBe(true);
		expect(heads.some((h) => /curriculum guides/i.test(h))).toBe(true);
	});

	it('renders each agency page as a safe external link', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const link = [...container.querySelectorAll('a')].find(
			(a) => a.getAttribute('href') === 'https://www.va.gov/test/'
		);
		expect(link).toBeTruthy();
		expect(link?.getAttribute('target')).toBe('_blank');
		const rel = link?.getAttribute('rel') ?? '';
		expect(rel).toContain('noopener');
		expect(rel).toContain('noreferrer');
	});

	it('shows the publisher tag on an agency row', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const row = [...container.querySelectorAll('li')].find((li) =>
			li.textContent?.includes('DoD - Test')
		);
		expect(row?.textContent ?? '').toContain('DoD');
		const tag = row?.querySelector('.src-tag');
		expect(tag?.textContent ?? '').toContain('Published by');
	});

	it('renders exactly one TAP library link', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const tapLinks = [...container.querySelectorAll('a')].filter(
			(a) => a.getAttribute('href') === 'https://www.tapevents.mil/resources/documents'
		);
		expect(tapLinks).toHaveLength(1);
		expect(tapLinks[0]?.getAttribute('target')).toBe('_blank');
	});

	it('lists TAP guide titles as plain text, not links', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		expect(container.textContent ?? '').toContain('TAP - Guide One');
		const asLink = [...container.querySelectorAll('a')].some((a) =>
			a.textContent?.includes('TAP - Guide One')
		);
		expect(asLink).toBe(false);
	});

	// Contractors whose work the guide files show are credited by name, in the TAP section, without claiming they
	// wrote the text.
	it('credits the contractors whose work the TAP guide files show', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const tap = container.querySelector('section[aria-labelledby="src-tap"]');
		expect(tap?.textContent?.replace(/\s+/g, ' ') ?? '').toContain(
			'The files of three guides show design work by agency contractors: Serco on the two DOL employment guides, and Cathexis on the VA Benefits and Services guide.'
		);
	});

	// The credit line names guides by hand; if one leaves the shipped index, the line is wrong and must change with it.
	it('names only guides the shipped index still lists', () => {
		const titles = SOURCES_INDEX.tapGuides.map((g) => g.title);
		for (const credited of [
			'TAP - DOL Employment Fundamentals of Career Transition (EFCT) Participant Guide',
			'TAP - DOL Employment Workshop Participant Guide',
			'TAP - VA Benefits and Services Participant Guide'
		])
			expect(titles).toContain(credited);
	});

	// A source title is a printed name and can carry one long unbroken word; on a 320 px phone it must wrap inside
	// its row, in an agency row and in a TAP guide row alike, not push the page sideways.
	it('on a 320 px phone a long unbroken title wraps inside its row and the page does not scroll sideways', async () => {
		const size = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(320, 800);
		try {
			const long = 'T'.repeat(60);
			const { container } = await render(SourceList, {
				props: {
					index: {
						...INDEX,
						agency: [{ title: long, url: 'https://www.va.gov/test/', publisher: 'VA' }],
						tapGuides: [{ title: long, publisher: 'VA' }]
					}
				}
			});
			const list = container.querySelector('.source-list') as HTMLElement;
			expect(list.clientWidth).toBeGreaterThan(0);
			expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
			for (const row of container.querySelectorAll('.src-row, .tap-titles li'))
				expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
		} finally {
			await page.viewport(size.width, size.height);
		}
	});

	it('gives every external link a visually-hidden new-tab hint', async () => {
		const { container } = await render(SourceList, { props: { index: INDEX } });
		const links = container.querySelectorAll('a[target="_blank"]');
		expect(links.length).toBeGreaterThan(0);
		for (const a of links) {
			expect(a.textContent ?? '').toMatch(/opens in a new tab/i);
		}
	});
});
