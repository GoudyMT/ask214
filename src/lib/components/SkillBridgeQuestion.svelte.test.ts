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
		onAnswer: (a: string) => Promise<string | null>;
		onClose: () => void;
	}> = {}
) {
	const onAnswer = props.onAnswer ?? vi.fn(() => Promise.resolve(null));
	const onClose = props.onClose ?? vi.fn();
	const r = render(SkillBridgeQuestion, {
		props: { wording: 'first', ...props, onAnswer, onClose }
	});
	return { ...r, onAnswer, onClose };
}

// Component tests run without app.css, so every case sets the tokens the card's CSS reads (sizes as app.css gives
// them, plain colours so the border keeps its width) and the body's type, and puts them back afterwards. Without
// them the card's padding and border compute to nothing and a frame that fits its message proves little.
const TOKENS: Record<string, string> = {
	'--space-xs': '4px',
	'--space-s': '8px',
	'--space-m': '16px',
	'--space-l': '24px',
	'--radius-l': '12px',
	'--font-size-s': '14px',
	'--color-surface': '#ffffff',
	'--color-border': '#888888',
	'--color-accent': '#1a66c2',
	'--color-fg': '#000000',
	'--color-fg-muted': '#555555',
	'--color-danger': '#b00020'
};
let bodyType = { fontSize: '', lineHeight: '' };
let frameSize = { width: 0, height: 0 };
beforeEach(() => {
	frameSize = { width: window.innerWidth, height: window.innerHeight };
	for (const [name, value] of Object.entries(TOKENS)) {
		document.documentElement.style.setProperty(name, value);
	}
	bodyType = { fontSize: document.body.style.fontSize, lineHeight: document.body.style.lineHeight };
	document.body.style.fontSize = '16px';
	document.body.style.lineHeight = '1.5';
});
afterEach(async () => {
	for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
	document.body.style.fontSize = bodyType.fontSize;
	document.body.style.lineHeight = bodyType.lineHeight;
	await page.viewport(frameSize.width, frameSize.height);
});

/** A frame that fits its message is the status line plus the frame's own padding and border, and nothing more. */
function expectFitsStatusLine(section: Element | null): void {
	expect(section).not.toBeNull();
	const frame = section as HTMLElement;
	const line = frame.querySelector('[role="status"]');
	expect(line).not.toBeNull();
	const style = getComputedStyle(frame);
	const own = [
		style.paddingTop,
		style.paddingBottom,
		style.borderTopWidth,
		style.borderBottomWidth
	].reduce((sum, width) => sum + parseFloat(width), 0);
	expect(own).toBeGreaterThan(30); // the tokens took effect: 2 x 16 px padding and 2 x 1 px border
	const expected = (line as HTMLElement).getBoundingClientRect().height + own;
	expect(Math.abs(frame.getBoundingClientRect().height - expected)).toBeLessThanOrEqual(1);
}

// Each case: the tapped label, the answer, the day the save resolves to, and the line that follows.
const ANSWERED_CASES = [
	[
		'Yes',
		'yes',
		null,
		'SkillBridge steps added to your timeline. You can change this in Settings.'
	],
	['No', 'no', null, 'Got it. You can change this in Settings.'],
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
] as const;

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
		const { container } = card({ wording: 'again' });
		await expect
			.element(page.getByRole('heading', { name: 'Still thinking about SkillBridge?' }))
			.toBeVisible();
		await expect
			.element(page.getByText(/works best from about 14 months before separation/))
			.toBeVisible();
		expect(makesPersonalClaim(textOf(container))).toBe(false);
	});

	it.each(ANSWERED_CASES)(
		'after %s (save resolves to %s) fits the frame to its message, focuses one line and offers only Dismiss',
		async (label, answer, returns, line) => {
			const { container, onAnswer } = card({ onAnswer: vi.fn(() => Promise.resolve(returns)) });
			const section = container.querySelector('section');
			const before = section?.getBoundingClientRect().height ?? 0;
			await page.getByRole('button', { name: label, exact: true }).click();
			expect(onAnswer).toHaveBeenCalledWith(answer);
			const status = page.getByRole('status');
			await expect.element(status).toHaveTextContent(line);
			expect(document.activeElement).toBe(status.element());
			expect(container.querySelectorAll('button')).toHaveLength(1);
			expect(page.getByRole('button', { name: 'Dismiss' }).elements()).toHaveLength(1);
			expect(section?.getBoundingClientRect().height ?? before).toBeLessThan(before - 20);
			expect(section?.style.minHeight).toBe('');
			expectFitsStatusLine(section);
			expect(makesPersonalClaim(line)).toBe(false);
		}
	);

	// The card is as wide as the page's content on a 320 px phone (16 px gutters), where the longest line wraps.
	it.each(ANSWERED_CASES)(
		'after %s (save resolves to %s) the message stops before the close button and the button stays inside the frame',
		async (label, _answer, returns, line) => {
			await page.viewport(320, 800);
			const { container } = card({ onAnswer: vi.fn(() => Promise.resolve(returns)) });
			container.style.width = '288px';
			await page.getByRole('button', { name: label, exact: true }).click();
			const status = page.getByRole('status');
			await expect.element(status).toHaveTextContent(line);
			const box = page.getByRole('button', { name: 'Dismiss' }).element().getBoundingClientRect();
			const frame = (container.querySelector('section') as HTMLElement).getBoundingClientRect();
			const range = document.createRange();
			range.selectNodeContents(status.element());
			const rects = Array.from(range.getClientRects());
			expect(rects.length).toBeGreaterThan(0);
			for (const r of rects) expect(r.right).toBeLessThanOrEqual(box.left + 1);
			expect(box.bottom).toBeLessThanOrEqual(frame.bottom);
		}
	);

	it('shows no close button before an answer', async () => {
		const { container } = card();
		await expect
			.element(page.getByRole('heading', { name: 'Planning to do SkillBridge?' }))
			.toBeVisible();
		expect(page.getByRole('button', { name: 'Dismiss' }).elements()).toHaveLength(0);
		expect(container.querySelectorAll('button')).toHaveLength(3);
	});

	it('offers a 44 px close button at the top right after an answer, and calls onClose once when tapped', async () => {
		const { container, onClose } = card();
		await page.getByRole('button', { name: 'No', exact: true }).click();
		const close = page.getByRole('button', { name: 'Dismiss' });
		await expect.element(close).toBeVisible();
		const button = close.element() as HTMLButtonElement;
		expect(button.type).toBe('button');
		const box = button.getBoundingClientRect();
		expect(box.width).toBeGreaterThanOrEqual(44);
		expect(box.height).toBeGreaterThanOrEqual(44);
		const frame = container.querySelector('section')?.getBoundingClientRect();
		expect(frame && frame.right - box.right).toBeLessThan(20);
		expect(frame && box.top - frame.top).toBeLessThan(20);
		expect(onClose).not.toHaveBeenCalled();
		await close.click();
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('says a failed save and keeps the question', async () => {
		card({ onAnswer: vi.fn(() => Promise.reject(new Error('E_TEST'))) });
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await expect
			.element(page.getByRole('alert'))
			.toHaveTextContent('Could not update right now - please try again.');
		expect(page.getByRole('button', { name: 'Yes', exact: true }).elements()).toHaveLength(1);
	});

	// The tapped button is disabled during the save, which drops focus to the body; the person must land back on it.
	it.each(['Yes', 'Not sure', 'No'])('puts focus back on %s after a failed save', async (label) => {
		card({ onAnswer: vi.fn(() => Promise.reject(new Error('E_TEST'))) });
		const tapped = page.getByRole('button', { name: label, exact: true });
		await tapped.click();
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(tapped).toBeEnabled();
		expect(document.activeElement).toBe(tapped.element());
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
		let finishSecond: (day: string | null) => void = () => {};
		const onAnswer = vi
			.fn<(a: string) => Promise<string | null>>()
			.mockImplementationOnce(() => new Promise<string | null>((_, reject) => (failFirst = reject)))
			.mockImplementationOnce(
				() => new Promise<string | null>((resolve) => (finishSecond = resolve))
			);
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
		finishSecond(null);
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

	const onClose = () => {};

	function pending() {
		let settle: { resolve: (day: string | null) => void; reject: (e: Error) => void } = {
			resolve: () => {},
			reject: () => {}
		};
		const onAnswer = vi.fn<(answer: string) => Promise<string | null>>(
			() =>
				new Promise<string | null>((resolve, reject) => {
					settle = { resolve, reject };
				})
		);
		return { onAnswer, settle: () => settle };
	}
	const FIRST = { name: 'Planning to do SkillBridge?' };
	const AGAIN = { name: 'Still thinking about SkillBridge?' };

	it('keeps the tapped question until the status line replaces it, then fits the frame to the line', async () => {
		await page.viewport(320, 800);
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, onAnswer, onClose };
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

		settle().resolve(null);
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(after).toBeLessThan(before - 20);
		expect(section?.style.minHeight).toBe('');
		expectFitsStatusLine(section);
	});

	it('fits the frame to the status line, even when the layout changes during the save', async () => {
		await page.viewport(700, 800);
		const { onAnswer, settle } = pending();
		const { container } = render(SkillBridgeQuestion, {
			props: { wording: 'first', onAnswer, onClose }
		});
		const section = container.querySelector('section');
		const before = section?.getBoundingClientRect().height ?? 0;
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await page.viewport(320, 800);
		const midSave = section?.getBoundingClientRect().height ?? 0;
		expect(midSave).toBeGreaterThan(before + 10);

		settle().resolve(null);
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(after).toBeLessThan(midSave - 20);
		expect(section?.style.minHeight).toBe('');
		expectFitsStatusLine(section);
	});

	it('fits the frame to the status line on a retry, after the error line is gone', async () => {
		await page.viewport(320, 800);
		const { onAnswer, settle } = pending();
		const { container } = render(SkillBridgeQuestion, {
			props: { wording: 'first', onAnswer, onClose }
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

		settle().resolve(null);
		await expect.element(page.getByRole('status')).toBeVisible();
		const after = section?.getBoundingClientRect().height ?? 0;
		expect(after).toBeLessThan(midSave - 20);
		expect(section?.style.minHeight).toBe('');
		expectFitsStatusLine(section);
	});

	// The save names the day it wrote; the card words its line from that, not from anything it read before the tap.
	it('words a Not sure line from the day the save resolves to, whatever the wording rerendered to meanwhile', async () => {
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, onAnswer, onClose };
		const { rerender } = render(SkillBridgeQuestion, { props });
		await page.getByRole('button', { name: 'Not sure', exact: true }).click();
		await rerender({ ...props, wording: 'again' });
		settle().resolve('2027-04-01');
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent("We'll ask again on Apr 1, 2027. You can change this in Settings.");
	});

	it('words a Not sure line as the steps line when the save resolves to no day', async () => {
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, onAnswer, onClose };
		const { rerender } = render(SkillBridgeQuestion, { props });
		await page.getByRole('button', { name: 'Not sure', exact: true }).click();
		await rerender({ ...props, wording: 'again' });
		settle().resolve(null);
		await expect
			.element(page.getByRole('status'))
			.toHaveTextContent(
				'SkillBridge steps added to your timeline. You can change this in Settings.'
			);
	});

	it('shows the current question again when the save fails', async () => {
		const { onAnswer, settle } = pending();
		const props = { wording: 'first' as const, onAnswer, onClose };
		const { rerender } = render(SkillBridgeQuestion, { props });
		await page.getByRole('button', { name: 'Yes', exact: true }).click();
		await rerender({ ...props, wording: 'again' });
		settle().reject(new Error('E_TEST'));
		await expect.element(page.getByRole('alert')).toBeVisible();
		await expect.element(page.getByRole('heading', AGAIN)).toBeVisible();
		expect(page.getByRole('heading', FIRST).elements()).toHaveLength(0);
	});
});
