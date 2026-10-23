import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import type { ZipsTable } from '../contract/tables';
import type { FinderFilters, FinderPlace, FinderSetup } from '../state/types';
import { INDUSTRIES } from '../contract/listing';
import { NOT_AFFILIATED } from './copy';
import Setup from './Setup.svelte';

const ZIPS: ZipsTable = {
	v: 1,
	rows: [
		['21044', 'MD', 39.21, -76.88],
		['21046', 'MD', 39.2, -76.86],
		['77001', 'TX', 29.7, -95.3]
	]
};

type Saved = { setup: FinderSetup; filters: FinderFilters };

function mount(
	extra: {
		zips?: ZipsTable | undefined;
		destination?: FinderPlace | null;
		initial?: Saved;
		error?: string | null;
	} = {}
) {
	const saved: Saved[] = [];
	const loadZips = vi.fn(() => Promise.resolve('zips' in extra ? extra.zips : ZIPS));
	const onsave = vi.fn((setup: FinderSetup, filters: FinderFilters) => {
		saved.push({ setup, filters });
		return Promise.resolve();
	});
	render(Setup, {
		loadZips,
		onsave,
		...(extra.destination !== undefined ? { destination: extra.destination } : {}),
		...(extra.initial ? { initial: extra.initial } : {}),
		...(extra.error !== undefined ? { error: extra.error } : {})
	});
	return { saved, loadZips, onsave };
}

const field = () => page.getByLabelText('ZIP code or state');
const next = () => page.getByRole('button', { name: 'Next' });
const back = () => page.getByRole('button', { name: 'Back' });
const show = () => page.getByRole('button', { name: 'Show programs' });
const heading = (name: string | RegExp) => page.getByRole('heading', { level: 2, name });

/** Steps 1 and 2 answered as they stand: on to the last step. */
async function toFields(): Promise<void> {
	await next().click();
	await expect.element(heading('How?')).toBeVisible();
	await next().click();
	await expect.element(heading(/^What field\?/)).toBeVisible();
}

/** Whatever is filled in, saved from the last step. */
async function finish(): Promise<void> {
	await toFields();
	await show().click();
}

describe('one question a step', () => {
	it('asks where, then how, then what field, saying which step of three it is on', async () => {
		mount();
		await expect.element(page.getByText('Step 1 of 3')).toBeVisible();
		await expect.element(heading('Where?')).toBeVisible();
		expect(show().elements()).toHaveLength(0);
		expect(back().elements()).toHaveLength(0);

		await next().click();
		await expect.element(page.getByText('Step 2 of 3')).toBeVisible();
		await expect.element(heading('How?')).toBeVisible();
		expect(field().elements()).toHaveLength(0);

		await next().click();
		await expect.element(page.getByText('Step 3 of 3')).toBeVisible();
		await expect.element(heading(/^What field\?/)).toBeVisible();
		// The last step saves; there is no step after it.
		await expect.element(show()).toBeVisible();
		expect(next().elements()).toHaveLength(0);
	});

	// A screen reader hears nothing when the content under it changes; moving focus to the new question says it.
	it("moves focus to each new step's question, going on and going back", async () => {
		mount();
		await next().click();
		await expect.element(heading('How?')).toHaveFocus();
		await next().click();
		await expect.element(heading(/^What field\?/)).toHaveFocus();
		await back().click();
		await expect.element(heading('How?')).toHaveFocus();
	});

	it('keeps every answer when going back, and saves them all at the end', async () => {
		const { saved } = mount();
		await field().fill('21046');
		await page.getByRole('button', { name: '100 mi' }).click();
		await next().click();
		await page.getByRole('button', { name: 'Hybrid' }).click();
		await next().click();
		await page.getByRole('button', { name: 'Management' }).click();

		await back().click();
		await expect
			.element(page.getByRole('button', { name: 'Hybrid' }))
			.toHaveAttribute('aria-pressed', 'true');
		await back().click();
		await expect.element(field()).toHaveValue('21046');
		await expect
			.element(page.getByRole('button', { name: '100 mi' }))
			.toHaveAttribute('aria-pressed', 'true');
		await finish();

		expect(saved).toEqual([
			{
				setup: {
					place: { kind: 'zip', zip: '21046' },
					radius: 100,
					territories: false,
					overseas: false
				},
				filters: { delivery: [3], industries: ['Management'] }
			}
		]);
	});

	// Going from step to step writes nothing: a person who leaves halfway has saved nothing.
	it('saves nothing until Show programs', async () => {
		const { saved } = mount();
		await field().fill('Maryland');
		await next().click();
		await page.getByRole('button', { name: 'Online' }).click();
		await next().click();

		expect(saved).toEqual([]);
	});

	it('takes Enter in the place field as Next, not as a save', async () => {
		const { saved } = mount();
		await field().fill('Maryland');
		await userEvent.keyboard('{Enter}');

		await expect.element(heading('How?')).toBeVisible();
		expect(saved).toEqual([]);
	});
});

describe('each part can be skipped', () => {
	it('Skip all saves a setup with no place, no format and no field', async () => {
		const { saved } = mount();
		await page.getByRole('button', { name: 'Skip all' }).click();

		expect(saved).toEqual([{ setup: { territories: false, overseas: false }, filters: {} }]);
	});

	// Skip all means skip the setup, whatever step it is pressed on; what was picked so far is left out.
	it('Skip all on a later step saves the same, leaving out what was picked', async () => {
		const { saved } = mount();
		await field().fill('Maryland');
		await next().click();
		await page.getByRole('button', { name: 'Hybrid' }).click();
		await page.getByRole('button', { name: 'Skip all' }).click();

		expect(saved).toEqual([{ setup: { territories: false, overseas: false }, filters: {} }]);
	});

	it('Show programs with nothing filled in saves the same', async () => {
		const { saved } = mount();
		await finish();

		expect(saved).toEqual([{ setup: { territories: false, overseas: false }, filters: {} }]);
	});
});

describe('where', () => {
	// A person who only knows the state still gets a list; no ZIP is asked for.
	it('accepts a state alone, with no radius', async () => {
		const { saved } = mount();
		await field().fill('Maryland');
		await finish();

		expect(saved[0]?.setup).toEqual({
			place: { kind: 'state', state: 'MD' },
			territories: false,
			overseas: false
		});
	});

	it('shows the radius pills only for a ZIP, preset to 50 miles, and saves the one picked', async () => {
		const { saved } = mount();
		await field().fill('Maryland');
		await expect.element(page.getByRole('button', { name: '25 mi' })).not.toBeInTheDocument();

		await field().fill('21046');
		await expect
			.element(page.getByRole('button', { name: '50 mi' }))
			.toHaveAttribute('aria-pressed', 'true');
		await page.getByRole('button', { name: '100 mi' }).click();
		await finish();

		expect(saved[0]?.setup).toEqual({
			place: { kind: 'zip', zip: '21046' },
			radius: 100,
			territories: false,
			overseas: false
		});
	});

	it('offers ZIPs as the digits are typed and fills the field from the one chosen', async () => {
		const { saved } = mount();
		await field().fill('210');
		await expect.element(page.getByRole('option', { name: '21044 - Maryland' })).toBeVisible();
		await page.getByRole('option', { name: '21046 - Maryland' }).click();
		await expect.element(field()).toHaveValue('21046 - Maryland');
		await finish();

		expect(saved[0]?.setup.place).toEqual({ kind: 'zip', zip: '21046' });
	});

	it('chooses a suggestion with the arrow keys and Enter', async () => {
		const { saved } = mount();
		await field().fill('tex');
		await expect.element(page.getByRole('option', { name: 'Texas' })).toBeVisible();
		await userEvent.keyboard('{ArrowDown}{Enter}');
		await expect.element(field()).toHaveValue('Texas');
		expect(saved).toEqual([]);
		await finish();

		expect(saved[0]?.setup.place).toEqual({ kind: 'state', state: 'TX' });
	});

	// A place the finder cannot use is said on the step that asks for it, with the field ready to fix, rather than
	// after two more questions.
	it('refuses a ZIP the table does not hold, staying on the first step with the field focused', async () => {
		const { saved } = mount();
		await field().fill('99999');
		await next().click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent("We couldn't find that ZIP code. Check it, or pick a state.");
		await expect.element(field()).toHaveFocus();
		expect(heading('How?').elements()).toHaveLength(0);
		expect(saved).toEqual([]);
	});

	it('refuses text that is neither a ZIP nor a state, and moves on once it is fixed', async () => {
		const { saved } = mount();
		await field().fill('somewhere nice');
		await next().click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Enter a 5-digit ZIP code or a state name.');
		expect(heading('How?').elements()).toHaveLength(0);

		await field().fill('Maryland');
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
		await finish();
		expect(saved[0]?.setup.place).toEqual({ kind: 'state', state: 'MD' });
	});

	it('says a ZIP needs the one-time table download when it could not be fetched', async () => {
		const { saved } = mount({ zips: undefined });
		await field().fill('21046');
		await next().click();

		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent(
				'A ZIP code needs a one-time download of the ZIP list. Check your connection, or pick a state.'
			);
		expect(heading('How?').elements()).toHaveLength(0);
		expect(saved).toEqual([]);
	});

	it('saves the territories and overseas boxes as ticked', async () => {
		const { saved } = mount();
		await page.getByRole('checkbox', { name: 'Include US territories' }).click();
		await page.getByRole('checkbox', { name: 'Include programs overseas' }).click();
		await finish();

		expect(saved[0]?.setup).toEqual({ territories: true, overseas: true });
	});
});

describe('the profile destination', () => {
	// What the person told the timeline is theirs to reuse, not the finder's to take: it reaches the field and the
	// record only on the tap.
	it('is offered by name, and saved only after the tap', async () => {
		const withoutTap = mount({ destination: { kind: 'state', state: 'TX' } });
		await expect.element(page.getByRole('button', { name: 'Use Texas' })).toBeVisible();
		await expect.element(field()).toHaveValue('');
		await finish();
		expect(withoutTap.saved[0]?.setup.place).toBeUndefined();
	});

	it('fills the field on the tap, and is saved with Show programs', async () => {
		const { saved } = mount({ destination: { kind: 'state', state: 'TX' } });
		await page.getByRole('button', { name: 'Use Texas' }).click();
		await expect.element(field()).toHaveValue('Texas');
		expect(saved).toEqual([]);
		await finish();

		expect(saved[0]?.setup.place).toEqual({ kind: 'state', state: 'TX' });
	});

	it('is not offered when the profile has none', async () => {
		mount();
		await expect.element(page.getByRole('button', { name: 'Use ' })).not.toBeInTheDocument();
	});
});

describe('how and what field', () => {
	it('picks several formats, which are saved as the site numbers them', async () => {
		const { saved } = mount();
		await next().click();
		await page.getByRole('button', { name: 'In person' }).click();
		await page.getByRole('button', { name: 'Hybrid' }).click();
		await expect
			.element(page.getByRole('button', { name: 'Hybrid' }))
			.toHaveAttribute('aria-pressed', 'true');
		await next().click();
		await show().click();

		expect(saved[0]?.filters).toEqual({ delivery: [1, 3] });
	});

	it('picks a field from the common six, and any of the 24 once they are all shown', async () => {
		const { saved } = mount();
		await toFields();
		await expect.element(page.getByRole('button', { name: 'Management' })).toBeVisible();
		await expect.element(page.getByRole('button', { name: 'Production' })).not.toBeInTheDocument();
		await page.getByRole('button', { name: 'Show all 24 fields' }).click();
		await page.getByRole('button', { name: 'Production' }).click();
		await page.getByRole('button', { name: 'Management' }).click();
		await show().click();

		expect(saved[0]?.filters).toEqual({ industries: ['Management', 'Production'] });
		expect(INDUSTRIES).toHaveLength(24);
	});

	it('shows every one of the 24 fields once asked', async () => {
		mount();
		await toFields();
		await page.getByRole('button', { name: 'Show all 24 fields' }).click();

		for (const name of INDUSTRIES) {
			await expect.element(page.getByRole('button', { name, exact: true })).toBeInTheDocument();
		}
	});
});

describe('changing a saved setup', () => {
	it('opens with the saved place, reach and choices already in place', async () => {
		const { saved } = mount({
			initial: {
				setup: {
					place: { kind: 'zip', zip: '21046' },
					radius: 25,
					territories: true,
					overseas: false
				},
				filters: { delivery: [2], industries: ['Management'] }
			}
		});
		await expect.element(field()).toHaveValue('21046');
		await expect
			.element(page.getByRole('button', { name: '25 mi' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(page.getByRole('checkbox', { name: 'Include US territories' }))
			.toBeChecked();
		await next().click();
		await expect
			.element(page.getByRole('button', { name: 'Online' }))
			.toHaveAttribute('aria-pressed', 'true');
		await next().click();
		await expect
			.element(page.getByRole('button', { name: 'Management' }))
			.toHaveAttribute('aria-pressed', 'true');
		await show().click();

		expect(saved[0]).toEqual({
			setup: {
				place: { kind: 'zip', zip: '21046' },
				radius: 25,
				territories: true,
				overseas: false
			},
			filters: { delivery: [2], industries: ['Management'] }
		});
	});
});

describe('nothing typed reaches the address', () => {
	// A form that submits by itself would put the typed ZIP in the query string, which lands in history and logs.
	it('keeps the address as it was after typing, pressing Enter and saving', async () => {
		const before = location.href;
		const { saved } = mount();
		await field().fill('Maryland');
		await userEvent.keyboard('{Enter}');
		await expect.element(heading('How?')).toBeVisible();
		expect(location.href).toBe(before);
		await next().click();
		await show().click();

		await vi.waitFor(() => expect(saved).toHaveLength(1));
		expect(location.href).toBe(before);
	});
});

// The first screen a person sees must say the site is independent of the Department of Defense and of Department of War.
describe('the independence line', () => {
	it('is shown in full on the setup screen', async () => {
		mount();

		await expect.element(page.getByText(NOT_AFFILIATED, { exact: true })).toBeVisible();
	});
});

describe('a save that fails', () => {
	it('shows the message it is given', async () => {
		mount({ error: 'Could not save. Try again.' });
		await expect.element(page.getByRole('alert')).toHaveTextContent('Could not save. Try again.');
	});
});
