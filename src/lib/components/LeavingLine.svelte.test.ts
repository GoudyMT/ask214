import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { page } from 'vitest/browser';
import LeavingLine from './LeavingLine.svelte';
import { makesPersonalClaim, textOf } from '$lib/timeline/personal-claim';

const show = (leaving: object | undefined) =>
	render(LeavingLine, { props: { leaving: leaving as never } });

describe('LeavingLine', () => {
	it('invites the dates when none is set', async () => {
		show(undefined);
		await expect
			.element(page.getByText(/Doing SkillBridge or taking terminal leave\?/))
			.toBeVisible();
		await expect
			.element(page.getByRole('link', { name: 'Add your dates in Settings' }))
			.toHaveAttribute('href', '/settings');
	});

	it('names the dates in use, with Change', async () => {
		show({ skillbridgeStart: '2026-11-01', terminalLeaveStart: '2027-04-01' });
		await expect
			.element(page.getByText(/SkillBridge from Nov 1, 2026\. Terminal leave from Apr 1, 2027\./))
			.toBeVisible();
		await expect.element(page.getByRole('link', { name: 'Change' })).toBeVisible();
	});

	it('says when a stored date is not used', async () => {
		show({ notUsed: { terminalLeaveStart: '2027-02-01' } });
		await expect
			.element(
				page.getByText(
					/Your terminal leave date \(Feb 1, 2027\) is after your separation date, so it isn't used\./
				)
			)
			.toBeVisible();
	});

	it('names SkillBridge when that is the date not used', async () => {
		show({ notUsed: { skillbridgeStart: '2027-05-02' } });
		await expect.element(page.getByText(/Your SkillBridge date \(May 2, 2027\)/)).toBeVisible();
	});

	it('carries no query and says nothing personal', () => {
		const { container } = show({ skillbridgeStart: '2026-11-01' });
		for (const a of container.querySelectorAll('a'))
			expect(a.getAttribute('href')).not.toContain('?');
		for (const line of textOf(container).split('\n')) expect(makesPersonalClaim(line)).toBe(false);
	});
});

// Component tests run without app.css, so the case sets the tokens and font the line uses and gives it the widths it
// gets on the Timeline: measured on the build, 272 px on a 320 px phone to 432 px at 480. The tokens are put back.
describe('LeavingLine (layout by width)', () => {
	const TOKENS: Record<string, string> = { '--space-l': '24px', '--font-size-s': '14px' };
	beforeEach(() => {
		for (const [name, value] of Object.entries(TOKENS)) {
			document.documentElement.style.setProperty(name, value);
		}
	});
	afterEach(() => {
		for (const name of Object.keys(TOKENS)) document.documentElement.style.removeProperty(name);
	});

	// Text widths differ a little between browsers, so the sweep covers every phone width; on the build the second
	// date split across two lines on 390 to 430 px phones.
	it('on phone widths each date stays whole, taking the next line when it does not fit', () => {
		const frames = [
			show({ skillbridgeStart: '2026-11-02', terminalLeaveStart: '2027-03-04' }).container,
			show({ notUsed: { terminalLeaveStart: '2027-05-04' } }).container
		];
		for (const frame of frames) {
			frame.style.fontFamily = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
			frame.style.lineHeight = '1.5';
		}
		const dates = frames.flatMap((frame) => [...frame.querySelectorAll('.leaving-line__date')]);
		expect(dates.map((d) => d.textContent)).toEqual(['Nov 2, 2026', 'Mar 4, 2027', 'May 4, 2027']);
		const lines = (el: Element) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return [...range.getClientRects()].filter((rect) => rect.width > 0);
		};
		const startsALine = (date: Element) => {
			const line = date.closest('.leaving-line')?.getBoundingClientRect();
			return line !== undefined && Math.abs(date.getBoundingClientRect().left - line.left) < 1;
		};
		let moved = 0;
		for (let width = 272; width <= 432; width++) {
			for (const frame of frames) frame.style.width = `${width}px`;
			for (const date of dates) {
				expect(lines(date), `${width} px: ${date.textContent ?? ''}`).toHaveLength(1);
				if (startsALine(date)) moved++;
			}
		}
		// The case is reached: somewhere in the sweep a date did not fit after the words before it.
		expect(moved).toBeGreaterThan(0);
	});
});
