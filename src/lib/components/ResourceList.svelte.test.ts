import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
import ResourceList from './ResourceList.svelte';
import { RESOURCES, type Resource } from '$lib/resources';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

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
	it('renders a heading for each display category with its label', async () => {
		const { container } = await render(ResourceList, { props: { resources: FIXTURE } });
		const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent?.trim());
		expect(headings).toContain('Benefits & VA');
		expect(headings).toContain('Claims filing (VSO)');
		expect(headings).toContain('Employment');
	});

	it('renders each resource as an external link that opens in a new tab safely', async () => {
		const { container } = await render(ResourceList, { props: { resources: FIXTURE } });
		const link = [...container.querySelectorAll('a')].find(
			(a) => a.getAttribute('href') === 'https://www.usajobs.gov'
		);
		expect(link).toBeTruthy();
		expect(link?.getAttribute('target')).toBe('_blank');
		const rel = link?.getAttribute('rel') ?? '';
		expect(rel).toContain('noopener');
		expect(rel).toContain('noreferrer');
	});

	it('shows the 38 CFR boundary note inside the Claims filing group only', async () => {
		const { container } = await render(ResourceList, { props: { resources: FIXTURE } });
		const claims = container.querySelector('[aria-labelledby="rg-claims-vso"]');
		expect(claims?.textContent ?? '').toMatch(/does(n't| not) help with VA claims/i);
		const benefits = container.querySelector('[aria-labelledby="rg-benefits-va"]');
		expect(benefits?.textContent ?? '').not.toMatch(/does(n't| not) help with VA claims/i);
	});

	it('renders resource descriptions', async () => {
		const { container } = await render(ResourceList, { props: { resources: FIXTURE } });
		expect(container.textContent ?? '').toContain('Federal jobs.');
	});

	describe('command instructions line', () => {
		const LINE =
			"Also follow your command's SkillBridge instructions: they set what your request package needs.";

		function groupOf(container: Element, heading: string): Element {
			const h2 = [...container.querySelectorAll('h2')].find(
				(h) => h.textContent?.trim() === heading
			);
			const section = h2?.closest('section');
			if (!section) throw new Error('E_NO_GROUP');
			return section;
		}

		it('sits under the SkillBridge & Transition heading and before its links', async () => {
			const { container } = await render(ResourceList, { props: { resources: RESOURCES } });
			const section = groupOf(container, 'SkillBridge & Transition');
			const notes = [...section.querySelectorAll('p')].filter(
				(p) => p.textContent?.trim() === LINE
			);
			expect(notes).toHaveLength(1);
			const note = notes[0] as HTMLElement;
			const h2 = section.querySelector('h2') as HTMLElement;
			const list = section.querySelector('ul') as HTMLElement;
			expect(h2.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(note.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			expect(list.contains(note)).toBe(false);
		});

		it('appears in no other group', async () => {
			const { container } = await render(ResourceList, { props: { resources: RESOURCES } });
			const sections = [...container.querySelectorAll('section')];
			const others = sections.filter(
				(s) => s.querySelector('h2')?.textContent?.trim() !== 'SkillBridge & Transition'
			);
			expect(others.length).toBeGreaterThan(0);
			for (const s of others) expect(s.textContent ?? '').not.toContain(LINE);
			expect(sections.filter((s) => (s.textContent ?? '').includes(LINE))).toHaveLength(1);
		});

		it('makes no personal claim anywhere in the group', async () => {
			const { container } = await render(ResourceList, { props: { resources: RESOURCES } });
			const section = groupOf(container, 'SkillBridge & Transition');
			expect(textOf(section)).toContain(LINE);
			expect(makesPersonalClaim(textOf(section))).toBe(false);
		});
	});
});
