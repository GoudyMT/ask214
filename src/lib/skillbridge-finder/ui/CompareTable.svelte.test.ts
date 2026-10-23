import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import CompareTable from './CompareTable.svelte';
import type { Listing } from '../contract/listing';
import { BRANCHES } from '../contract/listing';

const base = (over: Partial<Listing> & Pick<Listing, 'i' | 'n' | 'p'>): Listing => ({
	o: over.i,
	m: 1,
	b: [],
	ind: ['Production'],
	dib: false,
	dc: '2026-10-01',
	fl: '2026-10-07',
	...over
});

const GRID = base({
	i: 101,
	n: 'Example Chesapeake Grid Partners',
	p: 'Substation Technician Apprenticeship',
	c: 'Baltimore',
	s: 'MD',
	la: 39.29,
	lo: -76.61,
	d: '151-180',
	b: [],
	ind: ['Installation, Maintenance, and Repair', 'Construction and Extraction']
});
const WIND = base({
	i: 102,
	n: 'Example Wind Services',
	p: 'Field Technician Internship',
	ls: ['MD', 'VA'],
	d: '91-120',
	b: ['Army', 'Navy'],
	ind: ['Installation, Maintenance, and Repair']
});
const BLUE = base({
	i: 103,
	n: 'Example Blue Ridge Cyber Defense',
	p: 'Cyber Defense Analyst Internship',
	m: 2,
	b: [...BRANCHES],
	ind: ['Computer and Mathematical']
});

const handlers = () => ({
	onremove: vi.fn(),
	onback: vi.fn(),
	onadd: vi.fn(),
	onclear: vi.fn()
});

// Each cell as a person reads it: the row header, then one value per program, in column order.
const row = (container: Element, name: string): string[] => {
	const th = [...container.querySelectorAll('tbody th[scope="row"]')].find(
		(h) => h.textContent === name
	);
	if (!th) throw new Error('E_NO_ROW');
	return [...th.parentElement!.querySelectorAll('td')].map((td) => td.textContent ?? '');
};

describe('CompareTable', () => {
	it('shows each program in its own column, with its organization, program and a Remove', async () => {
		const { container } = await render(CompareTable, {
			props: { listings: [GRID, WIND, BLUE], ...handlers() }
		});
		const heads = [...container.querySelectorAll('thead th[scope="col"]')];
		expect(heads).toHaveLength(3);
		expect(heads[1]!.textContent).toContain('Example Wind Services');
		expect(heads[1]!.textContent).toContain('Field Technician Internship');
		expect(heads[1]!.querySelector('button')?.textContent?.trim()).toBe('Remove');
		expect(heads[0]!.querySelector('.compare__org')).not.toBeNull();
		expect(getComputedStyle(heads[0]!.querySelector('.compare__org')!).fontWeight).toBe('600');
	});

	it('words where, length, branches and field the way the cards do', async () => {
		const { container } = await render(CompareTable, {
			props: { listings: [GRID, WIND, BLUE], ...handlers() }
		});
		expect(row(container, 'Where')).toEqual(['Baltimore, MD', 'Offered in 2 states', 'Online']);
		expect(row(container, 'Length')).toEqual(['151-180 days', '91-120 days', 'Length not listed']);
		expect(row(container, 'Listed for')).toEqual(['Any branch', 'Army, Navy', 'All branches']);
		expect(row(container, 'Field')).toEqual([
			'Installation, Maintenance, and Repair; Construction and Extraction',
			'Installation, Maintenance, and Repair',
			'Computer and Mathematical'
		]);
	});

	it('names a state with no city, and a listing with no place at all', async () => {
		const stateOnly = base({ i: 104, n: 'Example State Only', p: 'Welder', s: 'MD' });
		const nowhere = base({ i: 105, n: 'Example Nowhere', p: 'Clerk' });
		const { container } = await render(CompareTable, {
			props: { listings: [stateOnly, nowhere], ...handlers() }
		});
		expect(row(container, 'Where')).toEqual(['Maryland, no city listed', 'Location not listed']);
	});

	it('removes the program whose Remove was pressed', async () => {
		const h = handlers();
		const { container } = await render(CompareTable, {
			props: { listings: [GRID, WIND, BLUE], ...h }
		});
		const buttons = container.querySelectorAll<HTMLButtonElement>('thead button');
		buttons[1]!.click();
		expect(h.onremove).toHaveBeenCalledExactlyOnceWith(102);
	});

	it('goes back, adds another and clears all from its own buttons', async () => {
		const h = handlers();
		const { container } = await render(CompareTable, { props: { listings: [GRID, WIND], ...h } });
		const named = (text: string) =>
			[...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
		named('Back to programs').click();
		named('Add another').click();
		named('Clear all').click();
		expect(h.onback).toHaveBeenCalledOnce();
		expect(h.onadd).toHaveBeenCalledOnce();
		expect(h.onclear).toHaveBeenCalledOnce();
	});

	it('offers no Add another at three programs', async () => {
		const { container } = await render(CompareTable, {
			props: { listings: [GRID, WIND, BLUE], ...handlers() }
		});
		const texts = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
		expect(texts).not.toContain('Add another');
		expect(texts).toContain('Clear all');
	});

	it('marks a program the weekly files no longer list, and only that one', async () => {
		const { container } = await render(CompareTable, {
			props: { listings: [GRID, WIND], unlisted: new Set([WIND.i]), ...handlers() }
		});
		const heads = [...container.querySelectorAll('thead th[scope="col"]')];
		expect(heads[0]!.textContent).not.toContain('No longer listed');
		expect(heads[1]!.textContent).toContain('No longer listed');
	});

	it('says the finder is not affiliated, in the locked words', async () => {
		const { container } = await render(CompareTable, {
			props: { listings: [GRID], ...handlers() }
		});
		expect(container.textContent).toContain(
			'Listings from DoD SkillBridge (skillbridge.mil). Ask 214 is independent, not a Department of Defense or Department of War site, and not endorsed by either.'
		);
	});

	describe('on a 320 px phone with three long programs', () => {
		const size = { width: 0, height: 0 };
		beforeEach(async () => {
			size.width = window.innerWidth;
			size.height = window.innerHeight;
			await page.viewport(320, 800);
		});
		afterEach(async () => {
			await page.viewport(size.width, size.height);
		});

		const long = (n: number): Listing =>
			base({
				i: 200 + n,
				n: `Example Organization With A Very Long Name Number ${n} Incorporated`,
				p: `Program ${n} ${'Apprenticeship '.repeat(4)}`,
				ls: ['MD', 'VA', 'PA'],
				b: ['Army', 'Navy', 'Coast Guard'],
				ind: [
					'Installation, Maintenance, and Repair',
					'Arts, Design, Entertainment, Sports, and Media'
				]
			});

		it('scrolls the table inside its box, not the page', async () => {
			const { container } = await render(CompareTable, {
				props: { listings: [long(1), long(2), long(3)], ...handlers() }
			});
			const box = container.querySelector<HTMLElement>('.compare__scroll')!;
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
				document.documentElement.clientWidth
			);
			expect(box.scrollWidth).toBeGreaterThan(box.clientWidth);
			box.scrollLeft = 50;
			await vi.waitFor(() => expect(box.scrollLeft).toBeGreaterThan(0));
		});

		// The program columns must not squeeze the labels: "Where" set one letter to a line cannot be read.
		it('keeps every row label word whole on one line', async () => {
			const { container } = await render(CompareTable, {
				props: { listings: [long(1), long(2), long(3)], ...handlers() }
			});
			const broken: string[] = [];
			for (const th of container.querySelectorAll<HTMLElement>('tbody th[scope="row"]')) {
				const text = th.firstChild;
				if (!text || text.nodeType !== Node.TEXT_NODE) continue;
				const value = text.textContent ?? '';
				for (const match of value.matchAll(/\S+/g)) {
					const range = document.createRange();
					range.setStart(text, match.index);
					range.setEnd(text, match.index + match[0].length);
					const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
					if (lines.size > 1) broken.push(match[0]);
				}
			}
			expect(broken).toEqual([]);
		});

		it('keeps the row headers in view while the table scrolls', async () => {
			const { container } = await render(CompareTable, {
				props: { listings: [long(1), long(2), long(3)], ...handlers() }
			});
			const box = container.querySelector<HTMLElement>('.compare__scroll')!;
			const header = container.querySelector<HTMLElement>('tbody th[scope="row"]')!;
			const before = header.getBoundingClientRect().left;
			box.scrollLeft = 200;
			await vi.waitFor(() => expect(box.scrollLeft).toBeGreaterThan(0));
			expect(header.getBoundingClientRect().left).toBe(before);
		});
	});
});
