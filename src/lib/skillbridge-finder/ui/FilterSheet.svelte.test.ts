import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { bootstrapLocalKeystore } from '../../keystore/bootstrap';
import type { createFinderStore } from '../state/store.svelte';
import { deleteTestDb, openTestDb } from '../../db/_test-helpers';
import { device, network, startedSession } from './list-world';
import { useAppCss } from './app-css';
import FilterSheet from './FilterSheet.svelte';

// The sheet runs on a real finder record and a started session over a small published week: six programs, one of them
// online, in Maryland (so nothing is dropped by distance).
let db: IDBDatabase;
let dropCss: (() => void) | null = null;

beforeEach(async () => {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
});

afterEach(async () => {
	dropCss?.();
	dropCss = null;
	await page.viewport(414, 896);
	await deleteTestDb(db);
});

async function open(
	onclose: () => void = () => {},
	allFields = true,
	preset?: Parameters<ReturnType<typeof createFinderStore>['setFilters']>[0]
) {
	const dev = await device(db, {
		place: { kind: 'state', state: 'MD' },
		territories: false,
		overseas: false
	});
	if (preset) await dev.finder.setFilters(preset);
	const session = await startedSession(dev, network());
	const view = await render(FilterSheet, { session, finder: dev.finder, onclose });
	view.component.show();
	await expect.element(page.getByRole('dialog')).toBeVisible();
	// The sheet opens on the first eight fields; most cases need the one they name.
	if (allFields) await page.getByRole('button', { name: 'Show all 24' }).click();
	return { ...dev, session };
}

const box = (name: string) => page.getByRole('checkbox', { name });
const footer = () => page.getByRole('button', { name: /^Show \d+ programs?$/ });

describe('choices inside one filter add, and across filters narrow', () => {
	// Two formats are "either of these"; a field on top is "and in this field".
	it('shows programs in any ticked format, and only those also in a ticked field', async () => {
		const { finder } = await open();
		await expect.element(footer()).toHaveTextContent('Show 6 programs');

		await box('In person').click();
		await box('Hybrid').click();
		await expect.element(footer()).toHaveTextContent('Show 5 programs');
		await vi.waitFor(() => expect(finder.filters.delivery).toEqual([1, 3]));

		await box('Legal').click();
		await expect.element(footer()).toHaveTextContent('Show 2 programs');
		expect(finder.filters.industries).toEqual(['Legal']);
	});

	it('writes branch and length choices to the record', async () => {
		const { finder } = await open();
		await box('Army').click();
		await page.getByRole('button', { name: 'Up to 60 days' }).click();

		await vi.waitFor(() => expect(finder.filters.branches).toEqual(['Army']));
		// Both of the site's buckets inside "Up to 60 days" are chosen with one tap.
		await vi.waitFor(() => expect(finder.filters.durations).toEqual(['1-30', '31-60']));
		await expect
			.element(page.getByRole('button', { name: 'Up to 60 days' }))
			.toHaveAttribute('aria-pressed', 'true');
	});
});

describe('a count beside each value', () => {
	it('counts a field from the programs that pass the other filters', async () => {
		await open();
		await expect.element(box('Legal')).toHaveAccessibleName('Legal 2');
		await expect
			.element(box('Computer and Mathematical'))
			.toHaveAccessibleName('Computer and Mathematical 2');

		await box('In person').click();
		await expect.element(box('Legal')).toHaveAccessibleName('Legal 1');
		await expect
			.element(box('Computer and Mathematical'))
			.toHaveAccessibleName('Computer and Mathematical 1');
	});

	it('does not count a filter against itself, so a ticked value still shows what the others hold', async () => {
		const { finder } = await open();
		await box('Legal').click();
		// The count is read once the choice has landed, or it would pass on the old list.
		await vi.waitFor(() => expect(finder.filters.industries).toEqual(['Legal']));
		await expect.element(footer()).toHaveTextContent('Show 2 programs');

		await expect
			.element(box('Computer and Mathematical'))
			.toHaveAccessibleName('Computer and Mathematical 2');
	});

	// A value that would leave nothing cannot be picked; one already picked stays pickable so it can be undone.
	it('disables a value with no programs, and keeps a ticked one enabled', async () => {
		await open();
		await expect.element(box('Healthcare Support')).toBeEnabled();
		await box('Online').click();
		await expect.element(box('Healthcare Support')).toBeDisabled();
		await expect.element(box('Healthcare Support')).toHaveAccessibleName('Healthcare Support 0');
		await expect.element(box('Computer and Mathematical')).toBeEnabled();

		await box('Computer and Mathematical').click();
		await box('In person').click();
		// Online plus In person together is fine; Computer is still ticked and enabled.
		await expect.element(box('Computer and Mathematical')).toBeEnabled();
	});

	// Two choices that together leave nothing (from another tab, or an old record) must still be undoable.
	it('keeps a ticked value that leaves nothing enabled, so it can be unticked', async () => {
		const { finder } = await open(undefined, true, { delivery: [2], industries: ['Legal'] });
		await expect.element(box('Legal')).toBeChecked();
		await expect.element(box('Legal')).toBeEnabled();
		await expect.element(box('Legal')).toHaveAccessibleName('Legal 0');
		await expect.element(footer()).toHaveTextContent('Show 0 programs');

		await box('Legal').click();

		await vi.waitFor(() => expect(finder.filters).toEqual({ delivery: [2] }));
	});

	it('shows every one of the 24 fields once asked, the empty ones disabled', async () => {
		await open(undefined, false);
		await expect.element(box('Architecture and Engineering')).toBeVisible();
		await expect.element(box('Transportation and Material Moving')).not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Show all 24' }).click();

		await expect.element(box('Transportation and Material Moving')).toBeDisabled();
	});
});

// Focus must always land on something a person can read or use: not on the sheet's scrolling box, and not on the page
// when the button they pressed leaves.
describe('where focus goes', () => {
	// On a short phone screen the choices scroll, and the browser would put focus on that unnamed box.
	it('opens on the sheet heading', async () => {
		dropCss = useAppCss();
		await page.viewport(320, 568);
		await open(undefined, false);

		await expect.element(page.getByRole('heading', { name: 'Filters' })).toHaveFocus();
	});

	// A field with no programs is disabled and cannot take focus, so focus goes to the first one that can.
	it('moves to the first field Show all added that can be ticked, when its button goes', async () => {
		await open(undefined, false);
		await page.getByRole('button', { name: 'Show all 24' }).click();

		await expect.element(box('Healthcare Support')).toHaveFocus();
	});

	it('skips a field that was already shown because it was ticked', async () => {
		await open(undefined, false, { industries: ['Healthcare Support'] });
		await page.getByRole('button', { name: 'Show all 24' }).click();

		await expect.element(box('Legal')).toHaveFocus();
	});

	it('stays on the Field group when Show all adds nothing that can be ticked', async () => {
		// Only Air Force programs remain, and none of them is in a field the first eight leave out.
		await open(undefined, false, { branches: ['Air Force'] });
		await page.getByRole('button', { name: 'Show all 24' }).click();

		await expect.element(page.getByRole('group', { name: 'Field' })).toHaveFocus();
	});
});

describe('the footer', () => {
	it('Show N programs closes the sheet and names the count', async () => {
		const closed = vi.fn();
		await open(closed);
		await box('Online').click();
		await footer().click();

		expect(closed).toHaveBeenCalledOnce();
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	});

	it('says "1 program" for one', async () => {
		await open();
		await box('Online').click();

		await expect.element(footer()).toHaveTextContent('Show 1 program');
	});

	it('Clear all unticks every choice', async () => {
		const { finder } = await open();
		await box('In person').click();
		await box('Navy').click();
		await vi.waitFor(() => expect(finder.filters.delivery).toEqual([1]));
		await page.getByRole('button', { name: 'Clear all' }).click();

		await vi.waitFor(() => expect(finder.filters).toEqual({}));
		await expect.element(box('In person')).not.toBeChecked();
		await expect.element(footer()).toHaveTextContent('Show 6 programs');
	});

	it('Escape closes it', async () => {
		const closed = vi.fn();
		await open(closed);
		await userEvent.keyboard('{Escape}');

		await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
		await expect.element(page.getByRole('dialog')).not.toBeInTheDocument();
	});
});

describe('where it sits', () => {
	it('is a modal dialog, so the page behind it cannot be reached', async () => {
		await open();

		expect((page.getByRole('dialog').element() as HTMLDialogElement).matches(':modal')).toBe(true);
	});

	it('is a bottom sheet below 600 px and a centred dialog from 600 px', async () => {
		dropCss = useAppCss();
		await page.viewport(414, 800);
		await open();
		const dialog = page.getByRole('dialog').element() as HTMLDialogElement;
		let box = dialog.getBoundingClientRect();
		expect(Math.round(box.bottom)).toBe(innerHeight);
		expect(Math.round(box.width)).toBe(innerWidth);
		dialog.close();

		await page.viewport(900, 800);
		dialog.showModal();
		await expect.poll(() => dialog.getBoundingClientRect().width).toBeLessThan(innerWidth);
		box = dialog.getBoundingClientRect();
		expect(Math.round(box.left + box.width / 2)).toBe(Math.round(innerWidth / 2));
		expect(box.bottom).toBeLessThan(innerHeight);
	});

	// The footer is the one place to act on the choices; it must stay in view however long the list above it grows.
	it('keeps the footer in view while the choices scroll', async () => {
		dropCss = useAppCss();
		await page.viewport(414, 600);
		await open();
		const dialog = page.getByRole('dialog').element();
		const foot = footer().element().getBoundingClientRect();
		expect(foot.bottom).toBeLessThanOrEqual(innerHeight);
		const body = dialog.querySelector<HTMLElement>('.sheet__body');
		expect(body && body.scrollHeight > body.clientHeight).toBe(true);
		expect(getComputedStyle(body as HTMLElement).overflowY).toBe('auto');
		(body as HTMLElement).scrollTop = 10_000;
		expect((body as HTMLElement).scrollTop).toBeGreaterThan(0);
		expect(footer().element().getBoundingClientRect().top).toBe(foot.top);
	});
});
