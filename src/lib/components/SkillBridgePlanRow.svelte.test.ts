import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import SkillBridgePlanRow from './SkillBridgePlanRow.svelte';
import type { PlanRead } from '$lib/timeline/skillbridge-plan';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';
import { tokens } from '$lib/styles/tokens';

const plan = (over: Partial<PlanRead> = {}): PlanRead => ({
	answer: 'none',
	card: 'first',
	stepsShow: false,
	notSureReturns: '2027-04-01',
	returnsOn: null,
	...over
});
const toggle = () => page.getByRole('button', { name: /Planning SkillBridge/ });

describe('SkillBridgePlanRow', () => {
	it('shows Unavailable and offers no change while the answer cannot be read', async () => {
		const { container } = render(SkillBridgePlanRow, { props: { plan: null, onSave: vi.fn() } });
		await expect.element(toggle()).toHaveTextContent(/Unavailable/);
		await expect.element(toggle()).toBeDisabled();
		await expect
			.element(
				page.getByText(
					"Your timeline progress could not be loaded, so this answer can't be changed right now. Reload the app to try again."
				)
			)
			.toBeVisible();
		expect(makesPersonalClaim(textOf(container))).toBe(false);
	});

	it.each([
		['none', 'Not answered'],
		['yes', 'Yes'],
		['not-sure', 'Not sure'],
		['no', 'No']
	] as const)('summarises %s as %s', async (answer, summary) => {
		render(SkillBridgePlanRow, { props: { plan: plan({ answer }), onSave: vi.fn() } });
		// The summary is the row's last child: an exact match, so "No" cannot pass for "Not sure".
		await expect.poll(() => toggle().element().lastElementChild?.textContent).toBe(summary);
	});

	it('saves the picked answer, then closes and returns focus to the row', async () => {
		const onSave = vi.fn(() => Promise.resolve(null));
		const { container } = render(SkillBridgePlanRow, { props: { plan: plan(), onSave } });
		await toggle().click();
		const save = page.getByRole('button', { name: 'Save' });
		await expect.element(save).toBeDisabled(); // nothing picked yet
		await page.getByRole('radio', { name: 'Yes' }).click();
		await expect
			.element(
				page.getByText(
					"Yes adds SkillBridge's steps to your timeline. Not sure asks again on Apr 1, 2027."
				)
			)
			.toBeVisible();
		expect(makesPersonalClaim(textOf(container))).toBe(false);
		await save.click();
		expect(onSave).toHaveBeenCalledWith('yes');
		await expect.element(page.getByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
		expect(document.activeElement).toBe(toggle().element());
	});

	it('shows the late hint once a Not sure shows the steps', async () => {
		render(SkillBridgePlanRow, {
			props: { plan: plan({ notSureReturns: null }), onSave: vi.fn() }
		});
		await toggle().click();
		await expect
			.element(page.getByText("Yes or Not sure adds SkillBridge's steps to your timeline."))
			.toBeVisible();
	});

	// The hint describes the saved answer when it has something to say, else what a choice made today would do.
	it('names the saved return date while an early Not sure still waits', async () => {
		render(SkillBridgePlanRow, {
			props: {
				plan: plan({ answer: 'not-sure', returnsOn: '2027-02-01', notSureReturns: '2027-04-01' }),
				onSave: vi.fn()
			}
		});
		await toggle().click();
		await expect
			.element(
				page.getByText(
					"Yes adds SkillBridge's steps to your timeline. Not sure asks again on Feb 1, 2027."
				)
			)
			.toBeVisible();
	});

	it('reads the late hint for a saved Not sure that shows the steps, whatever a new Not sure would do', async () => {
		render(SkillBridgePlanRow, {
			props: {
				plan: plan({ answer: 'not-sure', stepsShow: true, notSureReturns: '2027-04-01' }),
				onSave: vi.fn()
			}
		});
		await toggle().click();
		await expect
			.element(page.getByText("Yes or Not sure adds SkillBridge's steps to your timeline."))
			.toBeVisible();
	});

	it('describes what a choice made today would do after any other saved answer', async () => {
		render(SkillBridgePlanRow, {
			props: { plan: plan({ answer: 'yes', stepsShow: true }), onSave: vi.fn() }
		});
		await toggle().click();
		await expect
			.element(
				page.getByText(
					"Yes adds SkillBridge's steps to your timeline. Not sure asks again on Apr 1, 2027."
				)
			)
			.toBeVisible();
	});

	it('keeps a returned message and says a failed save', async () => {
		const onSave = vi
			.fn<() => Promise<string | null>>()
			.mockResolvedValueOnce(
				'This was changed in another tab. We reloaded it - please review and save again.'
			)
			.mockRejectedValueOnce(new Error('E_TEST'));
		render(SkillBridgePlanRow, { props: { plan: plan({ answer: 'no' }), onSave } });
		await toggle().click();
		await expect.element(page.getByRole('radio', { name: 'No', exact: true })).toBeChecked();
		await page.getByRole('radio', { name: 'Not sure' }).click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent(/changed in another tab/);
		await page.getByRole('button', { name: 'Save' }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
	});

	it('Cancel saves nothing', async () => {
		const onSave = vi.fn();
		render(SkillBridgePlanRow, { props: { plan: plan(), onSave } });
		await toggle().click();
		await page.getByRole('radio', { name: 'No', exact: true }).click();
		await page.getByRole('button', { name: 'Cancel' }).click();
		expect(onSave).not.toHaveBeenCalled();
		await expect.element(page.getByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
		expect(document.activeElement).toBe(toggle().element());
	});

	it('opens and closes in place from the row, naming the group and the form it controls', async () => {
		render(SkillBridgePlanRow, { props: { plan: plan(), onSave: vi.fn() } });
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		await toggle().click();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true');
		await expect.element(page.getByRole('group', { name: 'Planning SkillBridge' })).toBeVisible();
		expect(toggle().element().getAttribute('aria-controls')).toBe(
			page.getByRole('group').element().closest('form')?.id
		);
		const values = page
			.getByRole('radio')
			.elements()
			.map((el) => (el as HTMLInputElement).value);
		expect(values).toEqual(['yes', 'not-sure', 'no']);
		await toggle().click();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		await expect.element(page.getByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
	});

	// The store can turn unreadable mid-save (a refresh after a failed write); the row must not stay half open.
	it('closes when the answer becomes unreadable, moves focus to the unavailable line, and stays closed when it returns', async () => {
		const onSave = vi.fn(() => Promise.resolve('Something to review.'));
		const props = { plan: plan(), onSave };
		const { rerender, container } = render(SkillBridgePlanRow, { props });
		await toggle().click();
		await page.getByRole('radio', { name: 'Yes' }).click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Something to review.');

		await rerender({ ...props, plan: null });
		await expect.element(toggle()).toBeDisabled();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		expect(container.querySelector('form')).toBeNull();
		const line = page.getByText(/could not be loaded/).element();
		expect(line.getAttribute('tabindex')).toBe('-1');
		expect(document.activeElement).toBe(line);

		await rerender({ ...props, plan: plan() });
		await expect.element(toggle()).toBeEnabled();
		await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false');
		expect(container.querySelector('form')).toBeNull();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();

		// Opened again, the form starts from the saved answer, not the stale pick.
		await toggle().click();
		await expect.element(page.getByRole('radio', { name: 'Yes' })).not.toBeChecked();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	it('does not take focus for the unavailable line when it was never open', async () => {
		render(SkillBridgePlanRow, { props: { plan: null, onSave: vi.fn() } });
		await expect.element(page.getByText(/could not be loaded/)).toBeVisible();
		expect(document.activeElement).toBe(document.body);
	});

	it('offers no unavailable line while the answer can be read', async () => {
		render(SkillBridgePlanRow, { props: { plan: plan(), onSave: vi.fn() } });
		await expect.element(toggle()).toBeEnabled();
		await expect.element(page.getByText(/could not be loaded/)).not.toBeInTheDocument();
	});

	it('pre-checks nothing before an answer, and clears the message once another is picked', async () => {
		const onSave = vi.fn(() => Promise.resolve('Something to review.'));
		render(SkillBridgePlanRow, { props: { plan: plan(), onSave } });
		await toggle().click();
		for (const name of ['Yes', 'Not sure', 'No']) {
			await expect.element(page.getByRole('radio', { name, exact: true })).not.toBeChecked();
		}
		await page.getByRole('radio', { name: 'Yes' }).click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.element(page.getByRole('alert')).toHaveTextContent('Something to review.');
		await page.getByRole('radio', { name: 'No', exact: true }).click();
		await expect.element(page.getByRole('alert')).not.toBeInTheDocument();
	});

	it('keeps the form from submitting to the page', async () => {
		render(SkillBridgePlanRow, {
			props: { plan: plan(), onSave: vi.fn(() => Promise.resolve(null)) }
		});
		await toggle().click();
		await page.getByRole('radio', { name: 'Yes' }).click();
		let prevented: boolean | null = null;
		const seen = (e: Event) => (prevented = e.defaultPrevented);
		document.addEventListener('submit', seen);
		try {
			await page.getByRole('button', { name: 'Save' }).click();
		} finally {
			document.removeEventListener('submit', seen);
		}
		expect(prevented).toBe(true);
	});

	it('holds Save while a save is under way', async () => {
		let finish: (message: string | null) => void = () => undefined;
		const onSave = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)));
		render(SkillBridgePlanRow, { props: { plan: plan(), onSave } });
		await toggle().click();
		await page.getByRole('radio', { name: 'Yes' }).click();
		await page.getByRole('button', { name: 'Save' }).click();
		await expect.element(page.getByRole('button', { name: 'Save' })).toBeDisabled();
		finish(null);
		await expect.element(page.getByRole('radio', { name: 'Yes' })).not.toBeInTheDocument();
	});
});

// Component tests run without app.css, so the cases set the tokens the pills use - the colours read from the app's
// token table, the sizes as app.css gives them - and put them back after each case.
describe('SkillBridgePlanRow (the choices as pills)', () => {
	const TOKENS: Record<string, string> = {
		'--space-s': '8px',
		'--space-m': '16px',
		'--font-size-s': '14px',
		'--color-accent': tokens.color.accent,
		'--color-border': tokens.color.border,
		'--color-fg': tokens.color.fg
	};
	/** A computed colour as the browser writes it, from a #rrggbb token. */
	const rgb = (hex: string) =>
		`rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
	beforeEach(() => {
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
	});
	afterEach(() => {
		for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
	});

	const pills = (container: HTMLElement) =>
		Array.from(container.querySelectorAll<HTMLElement>('.sb-row__choice')).map((label) => ({
			label,
			input: label.querySelector('input') as HTMLInputElement
		}));

	it('marks the chosen pill and leaves the others plain', async () => {
		const { container } = render(SkillBridgePlanRow, {
			props: { plan: plan({ answer: 'not-sure' }), onSave: vi.fn() }
		});
		await toggle().click();
		const all = pills(container);
		const chosen = all.filter((p) => p.input.checked);
		const plain = all.filter((p) => !p.input.checked);
		expect(chosen.map((p) => p.input.value)).toEqual(['not-sure']);
		// Read now: a computed style is live and would follow the pill when it is no longer chosen.
		const marked = {
			background: getComputedStyle(chosen[0]!.label).backgroundColor,
			border: getComputedStyle(chosen[0]!.label).borderTopColor,
			text: getComputedStyle(chosen[0]!.label).color
		};
		expect(marked.text).toBe(rgb(tokens.color.fg));
		for (const p of plain) {
			const style = getComputedStyle(p.label);
			expect(style.color).toBe(rgb(tokens.color.accent));
			expect(style.backgroundColor).toBe('rgba(0, 0, 0, 0)');
			expect(marked.background).not.toBe(style.backgroundColor);
			expect(marked.border).not.toBe(style.borderTopColor);
		}
		await page.getByRole('radio', { name: 'Yes' }).click();
		expect(getComputedStyle(pills(container)[0]!.label).backgroundColor).toBe(marked.background);
		expect(getComputedStyle(pills(container)[1]!.label).backgroundColor).toBe('rgba(0, 0, 0, 0)');
	});

	it('gives every pill a 44 px target that its radio covers', async () => {
		const { container } = render(SkillBridgePlanRow, { props: { plan: plan(), onSave: vi.fn() } });
		await toggle().click();
		const all = pills(container);
		expect(all).toHaveLength(3);
		for (const { label, input } of all) {
			const box = label.getBoundingClientRect();
			expect(box.height).toBeGreaterThanOrEqual(44);
			expect(input.getBoundingClientRect().width).toBe(box.width - 2);
			expect(getComputedStyle(input).opacity).toBe('0');
		}
	});

	// The radio is invisible, so the pill's ring is the only sign of where keyboard focus is: the app's 2 px solid
	// outline with a 2 px gap, as on every button and link. A pointer click does not show it.
	it('rings the focused pill when focus arrives by keyboard, not by pointer', async () => {
		const { container } = render(SkillBridgePlanRow, { props: { plan: plan(), onSave: vi.fn() } });
		await toggle().click();
		await userEvent.keyboard('{Tab}');
		const focused = document.activeElement as HTMLInputElement;
		expect(focused.type).toBe('radio');
		const ring = getComputedStyle(focused.closest('.sb-row__choice') as HTMLElement);
		expect([ring.outlineStyle, ring.outlineWidth, ring.outlineOffset]).toEqual([
			'solid',
			'2px',
			'2px'
		]);
		expect(ring.outlineColor).toBe(rgb(tokens.color.accent));

		await page.getByRole('radio', { name: 'No', exact: true }).click();
		const clicked = pills(container).find((p) => p.input.value === 'no')!;
		expect(document.activeElement).toBe(clicked.input);
		expect(getComputedStyle(clicked.label).outlineStyle).not.toBe('solid');
	});
});
