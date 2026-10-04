import { render } from 'vitest-browser-svelte';
import { describe, it, expect } from 'vitest';
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
