import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import ResourceList from './ResourceList.svelte';
import type { Resource } from '$lib/resources';

const FIXTURE: Resource[] = [
	{
		id: 'a',
		title: 'VA.gov',
		url: 'https://www.va.gov',
		description: 'Benefits hub.',
		displayCategory: 'benefits-va',
		lastVerified: '2026-08-09'
	},
	{
		id: 'b',
		title: 'Find a VSO',
		url: 'https://www.va.gov/get-help-from-accredited-representative/',
		description: 'Free accredited help.',
		displayCategory: 'claims-vso',
		lastVerified: '2026-08-09'
	},
	{
		id: 'c',
		title: 'USAJOBS',
		url: 'https://www.usajobs.gov',
		description: 'Federal jobs.',
		displayCategory: 'employment',
		lastVerified: '2026-08-09'
	}
];

describe('ResourceList', () => {
	it('renders a heading for each display category with its label', () => {
		const { container } = render(ResourceList, { props: { resources: FIXTURE } });
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
		expect(headings).toContain('Benefits & VA');
		expect(headings).toContain('Claims filing (VSO)');
		expect(headings).toContain('Employment');
	});

	it('renders each resource as an external link that opens in a new tab safely', () => {
		const { container } = render(ResourceList, { props: { resources: FIXTURE } });
		const link = [...container.querySelectorAll('a')].find(
			(a) => a.getAttribute('href') === 'https://www.usajobs.gov'
		);
		expect(link).toBeTruthy();
		expect(link?.getAttribute('target')).toBe('_blank');
		const rel = link?.getAttribute('rel') ?? '';
		expect(rel).toContain('noopener');
		expect(rel).toContain('noreferrer');
	});

	it('shows the 38 CFR boundary note inside the Claims filing group only', () => {
		const { container } = render(ResourceList, { props: { resources: FIXTURE } });
		const claims = container.querySelector('[aria-labelledby="rg-claims-vso"]');
		expect(claims?.textContent ?? '').toMatch(/does(n't| not) help with VA claims/i);
		const benefits = container.querySelector('[aria-labelledby="rg-benefits-va"]');
		expect(benefits?.textContent ?? '').not.toMatch(/does(n't| not) help with VA claims/i);
	});

	it('renders resource descriptions', () => {
		const { container } = render(ResourceList, { props: { resources: FIXTURE } });
		expect(container.textContent ?? '').toContain('Federal jobs.');
	});
});
