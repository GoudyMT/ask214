import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { deleteTestDb, openTestDb } from '../../db/_test-helpers';
import { cleanListing } from '../fixtures/clean';
import type { Listing } from '../contract/listing';
import type { SavedStatus } from '../state/saved-status';
import { createFinderSession } from './session.svelte';
import { device } from './list-world';
import { useAppCss } from './app-css';
import ProgramCard from './ProgramCard.svelte';

// The card runs on the real finder record and pack over a test database; its session is not started, since a card
// only marks programs opened through it.
const WIND = cleanListing({
	i: 7001,
	n: 'Example Wind Services',
	p: 'Field Technician Internship',
	ls: ['MD'],
	m: 1,
	dib: false,
	w: 'https://example.com/',
	li: 'https://www.linkedin.com/company/example-wind',
	e: 'careers@example.org',
	r: ['Field Technician', 'Wind Technician'],
	ind: ['Installation, Maintenance, and Repair', 'Construction and Extraction'],
	oc: ['91B', 'EM'],
	k: 'internship',
	dc: '2026-10-02',
	fl: '2026-10-14'
});

let db: IDBDatabase;
let dropCss: (() => void) | null = null;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
});

afterEach(async () => {
	dropCss?.();
	dropCss = null;
	await deleteTestDb(db);
});

async function mount(
	listing: Listing = WIND,
	over: { isNew?: boolean; miles?: number; status?: SavedStatus } = {}
) {
	const dev = await device(db, {});
	const session = createFinderSession({
		finder: dev.finder,
		pack: dev.pack,
		fetchFn: () => Promise.reject(new TypeError('offline')),
		workerPassesData: () => Promise.resolve(true)
	});
	const view = await render(ProgramCard, {
		listing,
		isNew: over.isNew ?? false,
		session,
		finder: dev.finder,
		...(over.miles !== undefined ? { miles: over.miles } : {}),
		...(over.status !== undefined ? { status: over.status } : {})
	});
	return { ...dev, session, view };
}

function withoutEmail(listing: Listing): Listing {
	const copy = { ...listing };
	delete copy.e;
	return copy;
}

const summary = () => page.getByRole('heading', { level: 3 }).getByRole('button');
const pill = (name: string) => page.getByRole('button', { name, exact: true });

// The text of what a locator finds, read until it holds (or not) what the case names; a locator's own text match is
// whole-text, which is wrong for a card that holds many lines.
const textOf = (where: { element(): Element }) =>
	(where.element().textContent ?? '').replace(/\s+/g, ' ').trim();
const shows = (where: { element(): Element }, part: string) =>
	expect.poll(() => textOf(where)).toContain(part);
const hides = (where: { element(): Element }, part: string) =>
	expect.poll(() => textOf(where)).not.toContain(part);

describe('the closed card', () => {
	it('shows the format, the organization, the program, and the facts line', async () => {
		await mount(cleanListing({ ...WIND, dib: true, m: 3 }), { isNew: true, miles: 12.4 });

		for (const part of [
			'New',
			'Hybrid',
			'DIB',
			'Example Wind Services',
			'Field Technician Internship',
			'Columbia, MD - 12 mi',
			'91-120 days',
			'Army, Navy'
		]) {
			await shows(summary(), part);
		}
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');
	});

	it('names the format in words, so the icon alone never carries it', async () => {
		await mount();

		await shows(summary(), 'In person');
		expect(summary().element().querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('marks a saved program that left the weekly files, and drops Compare for it', async () => {
		await mount(WIND, { status: { kind: 'missing', since: '2026-10-14' } });

		await shows(summary(), 'No longer listed');
		expect(page.getByRole('button', { name: 'Compare' }).elements()).toHaveLength(0);
		await expect.element(pill('Save')).toBeVisible();
	});

	it('shows none of the New, DIB or No longer listed tags when none applies', async () => {
		await mount();

		await shows(summary(), 'In person');
		for (const word of ['New', 'DIB', 'No longer listed']) {
			await hides(summary(), word);
		}
	});
});

describe('opening and closing', () => {
	it('opens on a tap on the facts line, and closes on a second tap', async () => {
		await mount();
		await page.getByText('Columbia, MD').click();
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'true');

		await page.getByText('Columbia, MD').click();
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');
	});

	it('opens on a tap on the card itself, away from every control', async () => {
		await mount();
		await page.getByRole('article').click({ position: { x: 3, y: 3 } });

		await expect.element(summary()).toHaveAttribute('aria-expanded', 'true');
	});

	// Dragging across the card's text ends in a click on the card; that is a person selecting words to copy, not asking
	// to open it. The click is sent straight to the card so the selection stands, as it does after a real drag.
	it('stays closed when a click ends a text selection, and opens when nothing is selected', async () => {
		await mount();
		const card = page.getByRole('article').element();
		const org = card.querySelector('.card__org') as Element;
		const selection = window.getSelection() as Selection;
		const click = () => card.dispatchEvent(new MouseEvent('click', { bubbles: true }));

		try {
			selection.selectAllChildren(org);
			expect(selection.isCollapsed).toBe(false);
			click();
			await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');

			selection.removeAllRanges();
			click();
			await expect.element(summary()).toHaveAttribute('aria-expanded', 'true');
		} finally {
			selection.removeAllRanges();
		}
	});

	// The cue is a picture of the control, not a second one: a tap on it must land on the card.
	it('opens on a tap on the Details cue, which is not a control of its own', async () => {
		await mount();
		await page.getByText('Details').click();

		await expect.element(summary()).toHaveAttribute('aria-expanded', 'true');
		await expect.element(page.getByText('Less')).toBeVisible();
	});

	it('does not open on a tap on Save or Compare, and keeps the choice', async () => {
		const { finder } = await mount();
		await pill('Save').click();
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');
		await pill('Compare').click();
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');

		await vi.waitFor(() => expect(finder.saved.map((s) => s.id)).toEqual([7001]));
		await vi.waitFor(() => expect(finder.compare).toEqual([7001]));
		await expect.element(pill('Saved')).toHaveAttribute('aria-pressed', 'true');
		await expect.element(pill('Comparing')).toHaveAttribute('aria-pressed', 'true');
	});

	it('does not close on a tap on a link inside the details', async () => {
		await mount();
		await summary().click();
		const link = page.getByRole('link', { name: /Company website/ });
		link.element().addEventListener('click', (e) => e.preventDefault());
		await link.click();

		await expect.element(summary()).toHaveAttribute('aria-expanded', 'true');
	});

	// Opened here is seen: the New tag and the count stop pointing at it.
	it('marks the program opened, so it is no longer New', async () => {
		const { pack } = await mount(WIND, { isNew: true });
		expect(pack.seen.has(7001)).toBe(false);
		await summary().click();

		await vi.waitFor(() => expect(pack.seen.has(7001)).toBe(true));
	});

	it('keeps the closed details out of reach of the keyboard and of a screen reader', async () => {
		await mount();
		const details = page
			.getByRole('article')
			.element()
			.querySelector<HTMLElement>('.card__details');

		expect(details?.inert).toBe(true);
		await summary().click();
		expect(details?.inert).toBe(false);
	});
});

describe('the details', () => {
	it('lists roles, fields, job codes, type, the posted date and the contact', async () => {
		await mount();
		await summary().click();

		const card = page.getByRole('article');
		for (const part of [
			'Field Technician, Wind Technician',
			'Installation, Maintenance, and Repair; Construction and Extraction',
			'91B, EM',
			'Internship',
			'Oct 2, 2026 on skillbridge.mil',
			'careers@example.org',
			'Shown as DoD lists it publicly on skillbridge.mil.'
		]) {
			await shows(card, part);
		}
	});

	it('says open to all occupations in the place of the codes', async () => {
		await mount(cleanListing({ ...WIND, oc: 'all' }));
		await summary().click();
		await shows(page.getByRole('article'), 'Open to all occupations');
	});

	it('gives a form link with its host in place of an email', async () => {
		await mount({ ...withoutEmail(WIND), u: 'https://forms.example.com/apply' });
		await summary().click();

		const link = page.getByRole('link', { name: /Online form at forms.example.com/ });
		expect(link.element().getAttribute('href')).toBe('https://forms.example.com/apply');
		expect(page.getByText('Shown as DoD lists it publicly').elements()).toHaveLength(0);
	});

	it('shows the DIB box only for a DIB program', async () => {
		await mount(cleanListing({ ...WIND, dib: true }));
		await summary().click();
		await expect
			.element(page.getByText(/Defense industry \(DIB\) programs can start up to 180 days out/))
			.toBeVisible();
	});

	it('links the company website and LinkedIn in a new tab, safely', async () => {
		await mount();
		await summary().click();

		for (const [name, href] of [
			['Company website', 'https://example.com/'],
			['LinkedIn', 'https://www.linkedin.com/company/example-wind']
		] as const) {
			const a = page.getByRole('link', { name: new RegExp(name) }).element();
			expect(a.getAttribute('href')).toBe(href);
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe('noopener noreferrer external');
		}
	});

	it('copies the organization name and opens skillbridge.mil in a new tab', async () => {
		const copied = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
		await mount();
		await summary().click();
		const link = page.getByRole('link', { name: /Copy the name, then open skillbridge.mil/ });
		// No real navigation from a test: the click is seen, then cancelled.
		const cancel = (e: Event) => e.preventDefault();
		document.addEventListener('click', cancel, { capture: true });
		try {
			await link.click();
		} finally {
			document.removeEventListener('click', cancel, { capture: true });
		}

		expect(copied).toHaveBeenCalledExactlyOnceWith('Example Wind Services');
		const a = link.element();
		expect(a.getAttribute('href')).toBe('https://www.skillbridge.mil/');
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe('noopener noreferrer external');
		await expect
			.element(
				page.getByText(
					'skillbridge.mil has no link to a single program. Paste the name into its search.'
				)
			)
			.toBeVisible();
	});
});

describe('a program with hostile text', () => {
	const HOSTILE = cleanListing({
		i: 7002,
		n: '<img src=x onerror=alert(1)>Evil Co',
		p: '<script>alert(1)</script> Program',
		ls: ['MD'],
		w: 'javascript:alert(1)',
		li: 'http://www.linkedin.com/company/x',
		e: 'a@example.org?bcc=x@example.org',
		r: ['<b>Boss</b>']
	});

	it('draws no live link from a script or plain-http address, and no injected markup', async () => {
		await mount(HOSTILE);
		await summary().click();

		const root = page.getByRole('article').element();
		expect(root.querySelectorAll('img, script, iframe, b').length).toBe(0);
		await shows(summary(), '<img src=x onerror=alert(1)>Evil Co');
		const hrefs = [...root.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
		expect(hrefs.some((h) => h.toLowerCase().startsWith('javascript:'))).toBe(false);
		expect(hrefs.some((h) => h.startsWith('http:'))).toBe(false);
		expect(page.getByRole('link', { name: /Company website/ }).elements()).toHaveLength(0);
		expect(page.getByRole('link', { name: /LinkedIn/ }).elements()).toHaveLength(0);
	});

	it('keeps extra mail headers inside the address', async () => {
		await mount(HOSTILE);
		await summary().click();

		const mail = page.getByRole('link', { name: /a@example.org/ }).element();
		expect(mail.getAttribute('href')).toBe('mailto:a%40example.org%3Fbcc%3Dx%40example.org');
	});

	it('draws no form link from a script address', async () => {
		await mount({ ...withoutEmail(HOSTILE), u: 'javascript:alert(1)' });
		await summary().click();

		expect(page.getByRole('link', { name: /Online form/ }).elements()).toHaveLength(0);
	});
});

describe('Save and Compare', () => {
	it('toggles Saved off again, and Comparing off again', async () => {
		const { finder } = await mount();
		await pill('Save').click();
		await vi.waitFor(() => expect(finder.saved).toHaveLength(1));
		await pill('Saved').click();
		await vi.waitFor(() => expect(finder.saved).toHaveLength(0));

		await pill('Compare').click();
		await vi.waitFor(() => expect(finder.compare).toEqual([7001]));
		await pill('Comparing').click();
		await vi.waitFor(() => expect(finder.compare).toEqual([]));
	});

	it('keeps the program whole when saved, so it outlives the weekly files', async () => {
		const { finder } = await mount();
		await pill('Save').click();

		await vi.waitFor(() => expect(finder.saved[0]?.facts).toEqual(WIND));
	});

	it('says so, and changes nothing, on a fourth compare', async () => {
		const { finder } = await mount();
		for (const id of [1, 2, 3]) await finder.addCompare(id);
		await pill('Compare').click();

		await expect
			.element(page.getByText('You can compare up to 3. Remove one first.'))
			.toBeVisible();
		expect(finder.compare).toEqual([1, 2, 3]);
		await expect.element(summary()).toHaveAttribute('aria-expanded', 'false');
	});
});

describe('motion', () => {
	const detailsOf = () =>
		page.getByRole('article').element().querySelector<HTMLElement>('.card__details') as HTMLElement;

	it('opens smoothly: the details grow over 220 ms', async () => {
		await mount();

		expect(getComputedStyle(detailsOf()).transitionDuration).toBe('0.22s');
		expect(getComputedStyle(detailsOf()).transitionProperty).toBe('grid-template-rows');
	});

	it('does not animate for a person who asked for less motion', async () => {
		const media = cdp();
		await media.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
		});
		try {
			await expect.poll(() => matchMedia('(prefers-reduced-motion: reduce)').matches).toBe(true);
			await mount();

			expect(getComputedStyle(detailsOf()).transitionDuration).toBe('0s');
		} finally {
			await media.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }]
			});
		}
	});
});

describe('the tag line', () => {
	const WIDTHS = Array.from({ length: 21 }, (_, n) => 320 + n * 8);
	const MIXES: [string, Listing, { isNew?: boolean; status?: SavedStatus }][] = [
		[
			'No longer listed, Hybrid and DIB',
			cleanListing({ ...WIND, m: 3, dib: true }),
			{ status: { kind: 'missing' } }
		],
		['New, In person and DIB', cleanListing({ ...WIND, m: 1, dib: true }), { isNew: true }]
	];

	// Four or five small tags are one line on the narrowest phone; a tag that drops to a second line makes every card
	// in the list a different height. Each tag's top is measured against the first's.
	it.each(MIXES)('keeps %s on one line from 320 to 480 px', async (_name, listing, over) => {
		dropCss = useAppCss();
		await mount(listing, over);
		const root = page.getByRole('article').element();
		const host = root.parentElement as HTMLElement;
		const tags = [...root.querySelectorAll<HTMLElement>('.card__tags > *')];
		expect(tags.length).toBeGreaterThanOrEqual(3);

		for (const width of WIDTHS) {
			// The page keeps 16 px each side of its column.
			host.style.width = `${width - 32}px`;
			const first = Math.round(tags[0]?.getBoundingClientRect().top ?? -1);
			expect(
				tags.map((t) => Math.round(t.getBoundingClientRect().top)),
				`${width} px`
			).toEqual(tags.map(() => first));
		}
	});
});
