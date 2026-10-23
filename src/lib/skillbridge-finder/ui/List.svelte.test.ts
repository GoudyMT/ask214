import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import { deleteTestDb, openTestDb } from '../../db/_test-helpers';
import { CREDIT_LINE, DIB_LINE } from './copy';
import { createFinderSession } from './session.svelte';
import { ALPHA, NOW, device, network, startedSession } from './list-world';
import type { FinderSetup } from '../state/types';
import List from './List.svelte';

// The list runs on a real finder record, pack and session over a small published week (see list-world.ts); only the
// card is replaced by a one-line stand-in, so the list is judged apart from what a card draws.
const STATE: FinderSetup = {
	place: { kind: 'state', state: 'MD' },
	territories: false,
	overseas: false
};
const ZIP: FinderSetup = {
	place: { kind: 'zip', zip: '21046' },
	radius: 25,
	territories: false,
	overseas: false
};

const card = createRawSnippet<
	[{ listing: { n: string; i: number }; isNew: boolean; status?: { kind: string } }]
>((args) => ({
	render: () => {
		const { listing, isNew, status } = args();
		// The real card's first button is its summary toggle, which is where the list sends focus.
		return `<article><button type="button">${listing.n}${isNew ? ' [new]' : ''}${status?.kind === 'missing' ? ' [gone]' : ''}</button></article>`;
	}
}));

let db: IDBDatabase;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
});

afterEach(async () => {
	vi.restoreAllMocks();
	await deleteTestDb(db);
});

async function mount(
	setup: FinderSetup = STATE,
	opts: {
		fillers?: number;
		now?: number;
		seen?: string;
		filters?: Parameters<Awaited<ReturnType<typeof device>>['finder']['setFilters']>[0];
	} = {}
) {
	const dev = await device(db, setup);
	if (opts.filters) await dev.finder.setFilters(opts.filters);
	if (opts.seen) await dev.pack.advanceLastSeen(opts.seen);
	const net = network(opts.fillers ?? 0);
	const session = await startedSession(dev, net, opts.now ?? NOW);
	await render(List, { session, finder: dev.finder, card });
	return { ...dev, session, net };
}

const cards = () => page.getByRole('article').elements();
const chip = (name: string) => page.getByRole('button', { name: `Remove ${name}` });
const search = () => page.getByLabelText('Search programs');

describe('the top of the page', () => {
	it('says which week the listings are from, and carries the not-affiliated line', async () => {
		await mount();

		await expect.element(page.getByText('Listings from Oct 21, 2026')).toBeVisible();
		await expect
			.element(
				page.getByText(
					'Listings from DoD SkillBridge (skillbridge.mil). Ask 214 is independent, not a Department of Defense or Department of War site, and not endorsed by either.'
				)
			)
			.toBeVisible();
	});

	// Past two weeks the pull is old, and a person must not take its New marks for this week's.
	it('says the listings are old past 14 days, and not at 14', async () => {
		await mount(STATE, { now: Date.UTC(2026, 10, 4, 12) });
		await expect.element(page.getByText('Listings from Oct 21, 2026')).toBeVisible();
		expect(page.getByText('These listings are from').elements()).toHaveLength(0);
	});

	it('shows the old-listings line in place of the date from day 15', async () => {
		await mount(STATE, { now: Date.UTC(2026, 10, 5, 12) });

		await expect
			.element(
				page.getByText(
					'These listings are from Oct 21, 2026. New ones load the next time you are online.'
				)
			)
			.toBeVisible();
		expect(page.getByText('Listings from Oct 21, 2026').elements()).toHaveLength(0);
	});

	it('closes with the defense-industry note and the data credit', async () => {
		await mount();

		// The whole legal line, word for word: a start alone would let the rest of it drift.
		await expect.element(page.getByText(DIB_LINE)).toBeVisible();
		await expect.element(page.getByText(CREDIT_LINE)).toBeVisible();
	});
});

describe('the count line and New', () => {
	it('counts the programs and the new ones', async () => {
		await mount();

		await expect.element(page.getByText('6 programs', { exact: true })).toBeVisible();
		await expect.element(page.getByText(/- 4 new/)).toBeVisible();
		expect(
			cards()
				.map((c) => c.textContent)
				.filter((t) => t?.includes('[new]'))
		).toHaveLength(4);
	});

	it('marks them all seen with one press', async () => {
		const { pack } = await mount();
		await page.getByRole('button', { name: 'Mark all seen' }).click();

		await expect.element(page.getByText(/- 4 new/)).not.toBeInTheDocument();
		await expect
			.element(page.getByRole('button', { name: 'Mark all seen' }))
			.not.toBeInTheDocument();
		expect(pack.seen.has(ALPHA.i)).toBe(true);
	});

	// After a month away, "new" would mean "since you last looked", which is not what the mark says.
	it('shows no new count past 4 missed weekly updates, and still lists the programs', async () => {
		await mount(STATE, { seen: '2026-09-09' });

		await expect.element(page.getByText('6 programs', { exact: true })).toBeVisible();
		expect(page.getByText(/ new/).elements()).toHaveLength(0);
		expect(page.getByRole('button', { name: 'Mark all seen' }).elements()).toHaveLength(0);
	});

	it('says "1 program" for one', async () => {
		await mount(STATE, { filters: { delivery: [2] } });

		await expect.element(page.getByText('1 program', { exact: true })).toBeVisible();
	});
});

describe('the sort line', () => {
	it('says nearest first with a ZIP', async () => {
		await mount(ZIP);

		await expect
			.element(page.getByText('Nearest first. Online, many-state and unplaced programs follow.'))
			.toBeVisible();
	});

	it('says distance needs a ZIP when only a state is set, with the state count', async () => {
		await mount(STATE);

		await expect.element(page.getByText('5 in Maryland. Distance needs a ZIP code.')).toBeVisible();
	});
});

describe('the chips', () => {
	const FILTERS = { delivery: [1, 3] as (1 | 2 | 3)[], industries: ['Legal' as const] };

	it('has one chip for the place and one for each choice, and a Filters button counting them', async () => {
		await mount(STATE, { filters: FILTERS });

		for (const name of ['In Maryland', 'In person', 'Hybrid', 'Legal']) {
			await expect.element(chip(name)).toBeVisible();
		}
		await expect.element(page.getByRole('button', { name: 'Filters (4)' })).toBeVisible();
	});

	it('takes away only the choice of the chip pressed', async () => {
		const { finder } = await mount(STATE, { filters: FILTERS });
		await chip('Hybrid').click();

		await vi.waitFor(() =>
			expect(finder.filters).toEqual({ delivery: [1], industries: ['Legal'] })
		);
		await expect.element(chip('Hybrid')).not.toBeInTheDocument();
		expect(finder.setup.place).toEqual({ kind: 'state', state: 'MD' });
	});

	it('takes the place away with its chip, keeping the territory choices', async () => {
		const { finder } = await mount(STATE, { filters: FILTERS });
		await chip('In Maryland').click();

		await vi.waitFor(() => expect(finder.setup).toEqual({ territories: false, overseas: false }));
		expect(finder.filters).toEqual(FILTERS);
	});

	it('offers Clear all from two chips, and it takes every choice away', async () => {
		const { finder } = await mount(STATE, { filters: FILTERS });
		await page.getByRole('button', { name: 'Clear all' }).click();

		await vi.waitFor(() => expect(finder.filters).toEqual({}));
		expect(finder.setup.place).toBeUndefined();
		await expect.element(page.getByRole('button', { name: 'Filters' })).toBeVisible();
	});

	it('offers no Clear all for one chip', async () => {
		await mount(STATE);

		expect(page.getByRole('button', { name: 'Clear all' }).elements()).toHaveLength(0);
	});
});

// A control that goes away while it holds focus drops focus to the top of the page, and a keyboard user starts over.
describe('where focus goes when the control pressed goes away', () => {
	const filtersButton = () => page.getByRole('button', { name: /^Filters/ });

	it('goes to the Filters button when a chip is removed', async () => {
		await mount(STATE, { filters: { delivery: [1, 3] } });
		await chip('Hybrid').click();

		await expect.element(chip('Hybrid')).not.toBeInTheDocument();
		await expect.element(filtersButton()).toHaveFocus();
	});

	it('goes to the Filters button after Clear all', async () => {
		await mount(STATE, { filters: { delivery: [1, 3] } });
		await page.getByRole('button', { name: 'Clear all' }).click();

		await expect.element(page.getByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
		await expect.element(filtersButton()).toHaveFocus();
	});

	it('goes to the Filters button after Mark all seen', async () => {
		await mount();
		await page.getByRole('button', { name: 'Mark all seen' }).click();

		await expect
			.element(page.getByRole('button', { name: 'Mark all seen' }))
			.not.toBeInTheDocument();
		await expect.element(filtersButton()).toHaveFocus();
	});

	it('goes to the first program that Show more added, only once the button has nothing left to add', async () => {
		await mount(STATE, { fillers: 54 });
		const more = page.getByRole('button', { name: 'Show 20 more' });
		await more.click();
		// Forty of sixty are shown: the button stays, and so does focus.
		await expect.element(more).toHaveFocus();

		await more.click();
		await expect.element(more).not.toBeInTheDocument();
		await expect
			.poll(() => document.activeElement)
			.toBe(page.getByRole('article').elements()[40]?.querySelector('button'));
	});
});

describe('the filter sheet from the list', () => {
	it('opens from the Filters button and gives focus back to it when Escape closes it', async () => {
		await mount();
		const button = page.getByRole('button', { name: /^Filters/ });
		await button.click();
		await expect.element(page.getByRole('dialog')).toBeVisible();
		await userEvent.keyboard('{Escape}');

		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
		await expect.element(button).toHaveFocus();
	});

	it('gives focus back to it when the footer closes the sheet', async () => {
		await mount();
		const button = page.getByRole('button', { name: /^Filters/ });
		await button.click();
		await page.getByRole('button', { name: /^Show \d+ programs?$/ }).click();

		await expect.element(button).toHaveFocus();
	});
});

describe('search', () => {
	it('narrows the list as the person types, and forgives one wrong letter', async () => {
		await mount();
		await search().fill('legal');
		await expect.element(page.getByText('2 programs', { exact: true })).toBeVisible();

		await search().fill('paralegl');
		await expect.element(page.getByText('1 program', { exact: true })).toBeVisible();
		expect(cards().map((c) => c.textContent)).toEqual(['Charlie Legal [new]']);
	});

	// Typing changes the count and moves nothing the person can feel; only a status line tells a screen reader.
	it('announces the count as a status, and its new text when the search narrows the list', async () => {
		await mount();
		const count = () => page.getByRole('status').element().textContent;
		await expect.poll(count).toContain('6 programs');

		await search().fill('legal');
		await expect.poll(count).toContain('2 programs');
	});

	it('searches inside the filters, not around them', async () => {
		await mount(STATE, { filters: { delivery: [3] } });
		await search().fill('legal');

		expect(cards().map((c) => c.textContent)).toEqual(['Echo Records']);
	});

	it('keeps what was typed out of the address', async () => {
		const before = location.href;
		await mount();
		await search().fill('legal');
		await userEvent.keyboard('{Enter}');

		expect(location.href).toBe(before);
	});
});

describe('searching every region with no place set', () => {
	it('asks first, sized from the index, and downloads only after the button', async () => {
		const { net } = await mount({ territories: false, overseas: false });
		await expect.element(page.getByText('1 program', { exact: true })).toBeVisible();
		expect(page.getByText('Search every region?').elements()).toHaveLength(0);
		await search().fill('delta');

		await expect.element(page.getByText('Search every region?')).toBeVisible();
		await expect.element(page.getByText(/about 10 MB of listings once/)).toBeVisible();
		const before = net.calls.length;
		expect(page.getByText('Delta Build').elements()).toHaveLength(0);

		await page.getByRole('button', { name: 'Search every region' }).click();

		await expect.element(page.getByText('Delta Build')).toBeVisible();
		expect(net.calls.length).toBeGreaterThan(before);
		expect(page.getByText('Search every region?').elements()).toHaveLength(0);
	});

	it('goes quiet on Near me only and downloads nothing', async () => {
		const { net } = await mount({ territories: false, overseas: false });
		await search().fill('delta');
		const before = net.calls.length;
		await page.getByRole('button', { name: 'Near me only' }).click();

		expect(page.getByText('Search every region?').elements()).toHaveLength(0);
		expect(net.calls.length).toBe(before);
	});

	it('does not ask a person who has a place', async () => {
		await mount(STATE);
		await search().fill('delta');

		await expect.element(page.getByText('Delta Build')).toBeVisible();
		expect(page.getByText('Search every region?').elements()).toHaveLength(0);
	});
});

describe('when nothing matches', () => {
	const NONE = { delivery: [2] as (1 | 2 | 3)[], industries: ['Legal' as const] };

	it('says so, and offers each choice to take away', async () => {
		const { finder } = await mount(STATE, { filters: NONE });

		await expect
			.element(page.getByRole('heading', { name: 'No programs match all of these' }))
			.toBeVisible();
		await expect.element(page.getByText('Remove one to see more:')).toBeVisible();
		expect(cards()).toHaveLength(0);

		await page
			.getByRole('region', { name: 'No programs match all of these' })
			.getByRole('button', { name: 'Remove Legal' })
			.click();

		await vi.waitFor(() => expect(finder.filters).toEqual({ delivery: [2] }));
		await expect.element(page.getByText('Foxtrot Online')).toBeVisible();
	});

	it('offers the search text as a choice to take away too', async () => {
		await mount(STATE);
		await search().fill('zzzz');
		await expect
			.element(page.getByRole('heading', { name: 'No programs match all of these' }))
			.toBeVisible();
		await page
			.getByRole('region', { name: 'No programs match all of these' })
			.getByRole('button', { name: 'Remove "zzzz"' })
			.click();

		await expect.element(page.getByText('6 programs', { exact: true })).toBeVisible();
		await expect.element(search()).toHaveValue('');
	});

	it('offers a wider reach from 25 miles, and fetches what the wider reach needs', async () => {
		const { finder, net } = await mount(ZIP, { filters: { industries: ['Management'] } });
		await expect.element(page.getByText('Or look farther:')).toBeVisible();
		await page.getByRole('button', { name: 'Within 100 mi' }).click();

		await vi.waitFor(() => expect(finder.setup.radius).toBe(100));
		await vi.waitFor(() =>
			expect(net.calls).toContain('/skillbridge-data/w/2026-10-21/middle-atlantic.json')
		);
	});

	it.each([
		['100 miles', { ...ZIP, radius: 100 as const }],
		['any distance', { ...ZIP, radius: 'any' as const }],
		['a state', STATE]
	])('offers no wider reach from %s', async (_name, setup) => {
		await mount(setup, { filters: { industries: ['Management'] } });
		await expect.element(page.getByText('Remove one to see more:')).toBeVisible();

		expect(page.getByText('Or look farther:').elements()).toHaveLength(0);
	});
});

describe('paging', () => {
	it('shows 20 programs, then 20 more on request', async () => {
		await mount(STATE, { fillers: 34 });

		await expect.element(page.getByText('40 programs', { exact: true })).toBeVisible();
		expect(cards()).toHaveLength(20);
		await page.getByRole('button', { name: 'Show 20 more' }).click();
		expect(cards()).toHaveLength(40);
		expect(page.getByRole('button', { name: /^Show \d+ more$/ }).elements()).toHaveLength(0);
	});

	it('names the rest when fewer than 20 remain, and starts over after a new search', async () => {
		await mount(STATE, { fillers: 30 });
		expect(cards()).toHaveLength(20);
		await page.getByRole('button', { name: 'Show 16 more' }).click();
		expect(cards()).toHaveLength(36);

		// The 30 look-alikes and Echo Records all hold "records": 31 programs, 20 of them shown to start with.
		await search().fill('records');
		await expect.element(page.getByText('31 programs', { exact: true })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Show 11 more' })).toBeVisible();
		expect(cards()).toHaveLength(20);
		await search().fill('');
		await expect.element(page.getByRole('button', { name: 'Show 16 more' })).toBeVisible();
		expect(cards()).toHaveLength(20);
	});
});

describe('the Saved tab', () => {
	it('lists the saved programs, with their count on the tab, and tells an empty list what to do', async () => {
		const { finder } = await mount();
		await expect.element(page.getByRole('tab', { name: 'Saved (0)' })).toBeVisible();
		await page.getByRole('tab', { name: 'Saved (0)' }).click();
		await expect.element(page.getByText('Nothing saved yet.')).toBeVisible();

		await finder.save(ALPHA, '2026-10-23');
		await expect
			.element(page.getByRole('tab', { name: 'Saved (1)' }))
			.toHaveAttribute('aria-selected', 'true');
		expect(cards().map((c) => c.textContent)).toEqual(['Alpha Systems']);
		await page.getByRole('tab', { name: 'Programs' }).click();
		await expect.element(page.getByText('6 programs', { exact: true })).toBeVisible();
	});

	// The cards are h3: without an h2 above them in the panel, a screen reader's heading list skips a level.
	it('puts a heading named for the tab at the top of each panel', async () => {
		await mount();
		const panel = page.getByRole('tabpanel');
		await expect
			.element(panel.getByRole('heading', { level: 2, name: 'Programs', exact: true }))
			.toBeInTheDocument();

		await page.getByRole('tab', { name: /^Saved/ }).click();
		await expect
			.element(panel.getByRole('heading', { level: 2, name: 'Saved', exact: true }))
			.toBeInTheDocument();
		expect(panel.getByRole('heading', { name: 'Programs', exact: true }).elements()).toHaveLength(
			0
		);
	});

	// A saved program that left the weekly files is still the person's; the card needs to be told it is gone.
	it('passes a saved program that is no longer listed to the card as missing', async () => {
		const { finder } = await mount();
		const gone = { ...ALPHA, i: 3999, n: 'Gone Industries' };
		await finder.save(gone, '2026-10-01');
		await page.getByRole('tab', { name: 'Saved (1)' }).click();

		expect(cards().map((c) => c.textContent)).toEqual(['Gone Industries [gone]']);
	});
});

describe('with nothing to show yet', () => {
	it('says it is offline and nothing is downloaded when the network is down on a first visit', async () => {
		// The phone itself is offline: that is the only case the offline line may claim.
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
		const dev = await device(db, STATE);
		const session = createFinderSession({
			finder: dev.finder,
			pack: dev.pack,
			fetchFn: () => Promise.reject(new TypeError('Failed to fetch')),
			now: () => NOW,
			workerPassesData: () => Promise.resolve(true)
		});
		await session.start();
		await render(List, { session, finder: dev.finder, card });

		await expect
			.element(page.getByText('You are offline and no listings are downloaded yet.'))
			.toBeVisible();
		expect(cards()).toHaveLength(0);
	});

	// The phone is online but the data host fails: "offline" would be untrue, and Try again is what helps.
	it('says listings could not be downloaded, with a way to try again, when the host fails while online', async () => {
		vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
		const dev = await device(db, STATE);
		const session = createFinderSession({
			finder: dev.finder,
			pack: dev.pack,
			fetchFn: () => Promise.resolve(new Response('down', { status: 503 })),
			now: () => NOW,
			workerPassesData: () => Promise.resolve(true)
		});
		await session.start();
		await render(List, { session, finder: dev.finder, card });

		await expect
			.element(page.getByText("Listings couldn't be downloaded right now."))
			.toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Try again' })).toBeVisible();
		expect(
			page.getByText('You are offline and no listings are downloaded yet.').elements()
		).toHaveLength(0);
	});

	it('says listings could not be downloaded, with a way to try again, when the worker refuses', async () => {
		const dev = await device(db, STATE);
		const net = network();
		const session = createFinderSession({
			finder: dev.finder,
			pack: dev.pack,
			fetchFn: net.fetchFn,
			now: () => NOW,
			workerPassesData: () => Promise.resolve(false)
		});
		await session.start();
		await render(List, { session, finder: dev.finder, card });

		await expect
			.element(page.getByText("Listings couldn't be downloaded right now."))
			.toBeVisible();
		expect(net.calls).toHaveLength(0);
		await expect.element(page.getByRole('button', { name: 'Try again' })).toBeVisible();
	});
});
