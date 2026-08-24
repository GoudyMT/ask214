import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import SourceList from './SourceList.svelte';
import type { SourcesIndex } from '$lib/sources/types';

const INDEX: SourcesIndex = {
	agency: [
		{ title: 'VA - Test Page', url: 'https://www.va.gov/test/', publisher: 'VA' },
		{ title: 'DoD - Test', url: 'https://www.militaryonesource.mil/test/', publisher: 'DoD' }
	],
	tapLibraryUrl: 'https://www.tapevents.mil/resources/documents',
	tapGuides: [
		{ title: 'TAP - Guide One', publisher: 'VA' },
		{ title: 'TAP - Guide Two', publisher: 'DoD' }
	]
};

describe('SourceList', () => {
	it('renders both section headings', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		const heads = [...container.querySelectorAll('h3')].map((h) => h.textContent ?? '');
		expect(heads.some((h) => /agency pages/i.test(h))).toBe(true);
		expect(heads.some((h) => /curriculum guides/i.test(h))).toBe(true);
	});

	it('renders each agency page as a safe external link', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		const link = [...container.querySelectorAll('a')].find(
			(a) => a.getAttribute('href') === 'https://www.va.gov/test/'
		);
		expect(link).toBeTruthy();
		expect(link?.getAttribute('target')).toBe('_blank');
		const rel = link?.getAttribute('rel') ?? '';
		expect(rel).toContain('noopener');
		expect(rel).toContain('noreferrer');
	});

	it('shows the publisher tag on an agency row', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		const row = [...container.querySelectorAll('li')].find((li) =>
			li.textContent?.includes('DoD - Test')
		);
		expect(row?.textContent ?? '').toContain('DoD');
		const tag = row?.querySelector('.src-tag');
		expect(tag?.textContent ?? '').toContain('Published by');
	});

	it('renders exactly one TAP library link', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		const tapLinks = [...container.querySelectorAll('a')].filter(
			(a) => a.getAttribute('href') === 'https://www.tapevents.mil/resources/documents'
		);
		expect(tapLinks).toHaveLength(1);
		expect(tapLinks[0]?.getAttribute('target')).toBe('_blank');
	});

	it('lists TAP guide titles as plain text, not links', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		expect(container.textContent ?? '').toContain('TAP - Guide One');
		const asLink = [...container.querySelectorAll('a')].some((a) =>
			a.textContent?.includes('TAP - Guide One')
		);
		expect(asLink).toBe(false);
	});

	it('gives every external link a visually-hidden new-tab hint', () => {
		const { container } = render(SourceList, { props: { index: INDEX } });
		const links = container.querySelectorAll('a[target="_blank"]');
		expect(links.length).toBeGreaterThan(0);
		for (const a of links) {
			expect(a.textContent ?? '').toMatch(/opens in a new tab/i);
		}
	});
});
