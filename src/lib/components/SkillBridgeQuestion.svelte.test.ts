import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { page } from 'vitest/browser';
import SkillBridgeQuestion from './SkillBridgeQuestion.svelte';
import { RESOURCES } from '$lib/resources';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

const SKILLBRIDGE = RESOURCES.find((r) => r.id === 'skillbridge');

function card(
	props: Partial<{
		wording: 'first' | 'again';
		notSureReturns: string | null;
		onAnswer: (a: string) => Promise<void>;
	}> = {}
) {
	const onAnswer = props.onAnswer ?? vi.fn(() => Promise.resolve());
	const r = render(SkillBridgeQuestion, {
		props: { wording: 'first', notSureReturns: '2027-04-01', ...props, onAnswer }
	});
	return { ...r, onAnswer };
}

describe('SkillBridgeQuestion', () => {
	it('asks in the first wording with three equal answers in a named group', async () => {
		const { container } = card();
		await expect
			.element(page.getByRole('heading', { name: 'Planning to do SkillBridge?' }))
			.toBeVisible();
		const group = page.getByRole('group', { name: 'Planning to do SkillBridge?' });
		await expect.element(group).toBeVisible();
		const buttons = group.getByRole('button').elements();
		expect(buttons.map((b) => b.textContent?.trim())).toEqual(['Yes', 'Not sure', 'No']);
		for (const b of buttons) expect(b.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
		expect(container.querySelectorAll('button')).toHaveLength(3); // no close button
		const link = page.getByRole('link', { name: /About SkillBridge/ });
		await expect.element(link).toHaveAttribute('href', SKILLBRIDGE?.url ?? 'missing');
		await expect.element(link).toHaveAttribute('rel', 'noopener noreferrer external');
		await expect
			.element(
				page.getByText(
					"Also follow your command's SkillBridge instructions: they set what your request package needs."
				)
			)
			.toBeVisible();
		const text = textOf(container);
		expect(makesPersonalClaim(text), text).toBe(false);
	});

	it('asks in the second wording', async () => {
		const { container } = card({ wording: 'again', notSureReturns: null });
		await expect
			.element(page.getByRole('heading', { name: 'Still thinking about SkillBridge?' }))
			.toBeVisible();
		await expect
			.element(page.getByText(/works best from about 14 months before separation/))
			.toBeVisible();
		expect(makesPersonalClaim(textOf(container))).toBe(false);
	});

	it.each([
		[
			'Yes',
			'yes',
			'2027-04-01',
			'SkillBridge steps added to your timeline. You can change this in Settings.'
		],
		['No', 'no', '2027-04-01', 'Got it. You can change this in Settings.'],
		[
			'Not sure',
			'not-sure',
			'2027-04-01',
			"We'll ask again on Apr 1, 2027. You can change this in Settings."
		],
		[
			'Not sure',
			'not-sure',
			null,
			'SkillBridge steps added to your timeline. You can change this in Settings.'
		]
	] as const)(
		'after %s (returns %s) keeps the frame and focuses one line',
		async (label, answer, returns, line) => {
			const { container, onAnswer } = card({ notSureReturns: returns });
			const section = container.querySelector('section');
			const before = section?.getBoundingClientRect().height ?? 0;
			await page.getByRole('button', { name: label, exact: true }).click();
			expect(onAnswer).toHaveBeenCalledWith(answer);
			const status = page.getByRole('status');
			await expect.element(status).toHaveTextContent(line);
			expect(document.activeElement).toBe(status.element());
			expect(container.querySelectorAll('button')).toHaveLength(0);
			expect(section?.getBoundingClientRect().height).toBeGreaterThanOrEqual(before - 1);
			expect(makesPersonalClaim(line)).toBe(false);
		}
	);

	it('says a failed save and keeps the question', async () => {
		card({ onAnswer: vi.fn(() => Promise.reject(new Error('E_TEST'))) });
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
		expect(page.getByRole('button', { name: 'Yes', exact: true }).elements()).toHaveLength(1);
	});

	it('names the card, and opens the link in a new tab and says so', async () => {
		const { container } = card();
		await expect
			.element(page.getByRole('region', { name: 'Planning to do SkillBridge?' }))
			.toBeVisible();
		const link = page.getByRole('link', { name: 'About SkillBridge (opens in a new tab)' });
		await expect.element(link).toHaveAttribute('target', '_blank');
		for (const b of container.querySelectorAll('button')) expect(b.type).toBe('button');
	});

	it('blocks a second tap while saving, frees the answers after a failed save, and clears the error on a retry', async () => {
		let failFirst: (e: Error) => void = () => {};
		let finishSecond: () => void = () => {};
		const onAnswer = vi
			.fn<(a: string) => Promise<void>>()
			.mockImplementationOnce(() => new Promise<void>((_, reject) => (failFirst = reject)))
			.mockImplementationOnce(() => new Promise<void>((resolve) => (finishSecond = resolve)));
		const { container } = card({ onAnswer });
		const yes = page.getByRole('button', { name: 'Yes', exact: true });
		const disabledStates = () =>
			Array.from(container.querySelectorAll('button')).map((b) => b.disabled);

		await yes.click();
		expect(disabledStates()).toEqual([true, true, true]);
		failFirst(new Error('E_TEST'));
		await expect.element(page.getByRole('alert')).toBeVisible();
		expect(disabledStates()).toEqual([false, false, false]);

		await yes.click();
		expect(page.getByRole('alert').elements()).toHaveLength(0);
		expect(disabledStates()).toEqual([true, true, true]);
		finishSecond();
		await expect.element(page.getByRole('status')).toBeVisible();
		expect(container.querySelector('section')?.hasAttribute('aria-labelledby')).toBe(false);
	});
});

// The page hands the card new props as soon as the store takes the answer, which is before the save settles.
describe('SkillBridgeQuestion when its props change during the save', () => {
	let size = { width: 0, height: 0 };
	beforeEach(() => {
		size = { width: window.innerWidth, height: window.innerHeight };
	});
	afterEach(async () => {
		await page.viewport(size.width, size.height);
	});

	function pending() {
		let settle: { resolve: () => void; reject: (e: Error) => void } = {
			resolve: () => {},
			reject: () => {}
		};
		const onAnswer = vi.fn<(answer: string) => Promise<void>>(
			() =>
				new Promise<void>((resolve, reject) => {
					settle = { resolve, reject };
				})
		);
		return { onAnswer, settle: () => settle };
	}
	const FIRST = { name: 'Planning to do SkillBridge?' };
	const AGAIN = { name: 'Still thinking about SkillBridge?' };

	it('keeps the frame height and the tapped question until the status line replaces it', async () => {
		await page.viewport(320, 800);
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, notSureReturns: '2027-04-01', onAnswer };
		const { container, rerender } = render(SkillBridgeQuestion, { props });
		const section = container.querySelector('section');
		const before = section?.getBoundingClientRect().height ?? 0;
		expect(before).toBeGreaterThan(0);

		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await rerender({ ...props, wording: 'again' });
		await expect.element(page.getByRole('heading', FIRST)).toBeVisible();
		expect(page.getByRole('heading', AGAIN).elements()).toHaveLength(0);
		await expect.element(page.getByText(/^SkillBridge is the DoD program/)).toBeVisible();
		expect(page.getByText(/works best from about 14 months/).elements()).toHaveLength(0);

		settle().resolve();
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
	});

	it('holds the height the card has when the status line replaces it, even when the layout changes during the save', async () => {
		await page.viewport(700, 800);
		const { onAnswer, settle } = pending();
		const { container } = render(SkillBridgeQuestion, {
			props: { wording: 'first', notSureReturns: '2027-04-01', onAnswer }
		});
		const section = container.querySelector('section');
		const before = section?.getBoundingClientRect().height ?? 0;
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await page.viewport(320, 800);
		const midSave = section?.getBoundingClientRect().height ?? 0;
		expect(midSave).toBeGreaterThan(before + 10);

		settle().resolve();
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(Math.abs(after - midSave)).toBeLessThanOrEqual(1);
	});

	it('holds the height the card has on a retry, after the error line is gone', async () => {
		await page.viewport(320, 800);
		const { onAnswer, settle } = pending();
		const { container } = render(SkillBridgeQuestion, {
			props: { wording: 'first', notSureReturns: '2027-04-01', onAnswer }
		});
		const section = container.querySelector('section');
		const yes = page.getByRole('button', { name: 'Yes', exact: true });
		await yes.click();
		settle().reject(new Error('E_TEST'));
		await expect.element(page.getByRole('alert')).toBeVisible();
		const withAlert = section?.getBoundingClientRect().height ?? 0;

		await yes.click();
		const midSave = section?.getBoundingClientRect().height ?? 0;
		expect(page.getByRole('alert').elements()).toHaveLength(0);
		expect(withAlert).toBeGreaterThan(midSave + 5);

		settle().resolve();
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(Math.abs(after - midSave)).toBeLessThanOrEqual(1);
	});

	it('words the status line from the props at the tap, not from the props at the end of the save', async () => {
		const { onAnswer, settle } = pending();
		const props = {
			wording: 'first' as const,
			notSureReturns: '2027-04-01' as string | null,
			onAnswer
		};
		const { rerender } = render(SkillBridgeQuestion, { props });
		await page.getByRole('button', { name: 'Not sure', exact: true }).click();
		await rerender({ ...props, notSureReturns: null });
		settle().resolve();
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent("We'll ask again on Apr 1, 2027. You can change this in Settings.");
	});

	it('shows the current question again when the save fails', async () => {
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, notSureReturns: '2027-04-01', onAnswer };
		const { rerender } = render(SkillBridgeQuestion, { props });
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await rerender({ ...props, wording: 'again' });
		settle().reject(new Error('E_TEST'));
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('heading', AGAIN)).toBeVisible();
		expect(page.getByRole('heading', FIRST).elements()).toHaveLength(0);
	});
});
