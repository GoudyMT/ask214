import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { cdp, page } from 'vitest/browser';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { deleteTestDb, openTestDb } from '../../db/_test-helpers';
import { cleanListing } from '../fixtures/clean';
import type { Listing } from '../contract/listing';
import type { SavedStatus } from '../state/saved-status';
import { createFinderSession } from './session.svelte';
import { device } from './list-world';
import { useAppCss } from './app-css';
import { NOT_AFFILIATED } from './copy';
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

	// The not-affiliated line is a legal line: the opened card must carry all of it, not a start.
	it('says in full that Ask 214 is independent of the Department of Defense', async () => {
		await mount();
		await summary().click();

		await shows(page.getByRole('article'), NOT_AFFILIATED);
	});

	// The list sends focus to the first button of a card when it adds one; that must be the summary toggle.
	it('has the summary toggle as its first button', async () => {
		await mount();

		expect(page.getByRole('article').element().querySelector('button')).toBe(summary().element());
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

// The Details cue ends the action row; on the narrowest phone, a picked program's wider "Comparing" must not push it
// onto a line of its own, where it reads as belonging to nothing.
it('keeps Save, Comparing and Details on one line at 320 px', async () => {
	dropCss = useAppCss();
	const size = { width: window.innerWidth, height: window.innerHeight };
	// The app's type sizes follow the viewport, so the phone's own width is set, not only the column's.
	await page.viewport(320, 800);
	onTestFinished(() => page.viewport(size.width, size.height));
	await mount();
	const root = page.getByRole('article').element();
	(root.parentElement as HTMLElement).style.width = `${320 - 32}px`;
	await page.getByRole('button', { name: 'Compare', exact: true }).click();
	await expect.element(page.getByRole('button', { name: 'Comparing' })).toBeVisible();

	// The list sits the card in a slightly narrower column than the page's (272 px measured on a 320 px phone).
	for (const width of [256, 264, 272, 280, 288]) {
		(root.parentElement as HTMLElement).style.width = `${width}px`;
		const parts = [...root.querySelectorAll<HTMLElement>('.card__actions > *')];
		const middles = parts.map((el) => {
			const r = el.getBoundingClientRect();
			return Math.round(r.top + r.height / 2);
		});
		expect(parts.length).toBeGreaterThanOrEqual(3);
		expect(middles, `${width} px`).toEqual(middles.map(() => middles[0]));
		// "Details" and its chevron stay side by side, not stacked.
		const cue = root.querySelector<HTMLElement>('.card__cue')!;
		expect(cue.getBoundingClientRect().height, `${width} px`).toBeLessThan(30);
	}
});

describe('the opened card, for a thumb', () => {
	const FORM = { ...withoutEmail(WIND), u: 'https://forms.example.com/apply' };

	// Every tap target is at least 44 px high; the text links in the details sat at 19 to 21 px.
	it.each([
		['the company, LinkedIn and email links', WIND, 3],
		['the online form link', FORM, 3]
	] as const)('makes %s at least 44 px high on a 320 px phone', async (_name, listing, count) => {
		dropCss = useAppCss();
		const size = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(320, 800);
		onTestFinished(() => page.viewport(size.width, size.height));
		await mount(listing);
		const root = page.getByRole('article').element();
		(root.parentElement as HTMLElement).style.width = `${320 - 32}px`;
		await summary().click();

		const links = [...root.querySelectorAll<HTMLElement>('.card__dl a, .card__links a')];
		expect(links).toHaveLength(count);
		for (const link of links) {
			expect(link.getBoundingClientRect().height, link.textContent ?? '').toBeGreaterThanOrEqual(
				44
			);
		}
	});
});

// WCAG 1.4.3: 14 px normal text needs 4.5:1. The pair is read from what the browser paints, over the card behind it.
describe('the "No longer listed" tag', () => {
	const channels = (css: string): [number, number, number, number] => {
		const n = (css.match(/[\d.]+(?:e-?\d+)?/g) ?? []).map(Number);
		// color(srgb 0.76 0.25 0.05 / 0.12) is on a 0..1 scale, rgb(194, 65, 12) on 0..255.
		const k = css.startsWith('color(') ? 255 : 1;
		return [(n[0] ?? 0) * k, (n[1] ?? 0) * k, (n[2] ?? 0) * k, n[3] ?? 1];
	};
	const luminance = ([r, g, b]: [number, number, number]) => {
		const lin = (c: number) => {
			const s = c / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		};
		return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
	};

	it.each(['light', 'dark'])('reads at 4.5:1 or better in the %s theme', async (theme) => {
		dropCss = useAppCss();
		document.documentElement.dataset.theme = theme;
		onTestFinished(() => {
			delete document.documentElement.dataset.theme;
		});
		await mount(WIND, { status: { kind: 'missing' } });

		const card = getComputedStyle(page.getByRole('article').element());
		const tag = getComputedStyle(
			page.getByRole('article').element().querySelector('.card__tag--gone') as Element
		);
		expect(tag.fontSize).toBe('14px');
		const [fr, fg, fb] = channels(tag.color);
		const [tr, tg, tb, ta] = channels(tag.backgroundColor);
		const [cr, cg, cb] = channels(card.backgroundColor);
		const text = luminance([fr, fg, fb]);
		const fill = luminance([
			tr * ta + cr * (1 - ta),
			tg * ta + cg * (1 - ta),
			tb * ta + cb * (1 - ta)
		]);
		const ratio = (Math.max(text, fill) + 0.05) / (Math.min(text, fill) + 0.05);

		expect(ratio).toBeGreaterThanOrEqual(4.5);
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
