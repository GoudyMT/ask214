import { expect, test, type Page } from '@playwright/test';

// Copied from leaving-command.e2e.ts: the E2E files share no helper module.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

async function seedProfile(page: Page, separationInDays: number): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(separationInDays));
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

const FIND = 'Find a SkillBridge program and get an acceptance letter';
const REQUEST = "Submit your SkillBridge request (MyNavy Education and your command's package)";

test('Yes shows both steps and keeps them after a reload', async ({ page }) => {
	await seedProfile(page, 208);
	await expect(
		page.getByRole('heading', { name: 'Still thinking about SkillBridge?' })
	).toBeVisible();
	await expect(page.getByText(FIND)).toHaveCount(0);
	await page
		.getByRole('group', { name: 'Still thinking about SkillBridge?' })
		.getByRole('button', { name: 'Yes', exact: true })
		.click();
	await expect(page.getByRole('status')).toHaveText(
		'SkillBridge steps added to your timeline. You can change this in Settings.'
	);
	await expect(page.getByRole('status')).toBeFocused();
	await expect(page.getByText(FIND)).toBeVisible();
	await expect(page.getByText(REQUEST)).toBeVisible();
	await page.reload();
	await expect(page.getByText(FIND)).toBeVisible();
	await expect(page.getByRole('heading', { name: /SkillBridge\?$/ })).toHaveCount(0);
});

test('an early Not sure hides the card and the steps, and says when it asks again', async ({
	page
}) => {
	await seedProfile(page, 632);
	await expect(page.getByRole('heading', { name: 'Planning to do SkillBridge?' })).toBeVisible();
	await page.getByRole('button', { name: 'Not sure', exact: true }).click();
	await expect(page.getByRole('status')).toHaveText(
		/^We'll ask again on .+\. You can change this in Settings\.$/
	);
	await page.reload();
	// The absence checks below pass on an empty page, so they wait for the loaded task list first.
	await expect(page.locator('[id^="task-"]').first()).toBeVisible();
	await expect(page.getByRole('heading', { name: /SkillBridge\?$/ })).toHaveCount(0);
	await expect(page.getByText(FIND)).toHaveCount(0);
});

test('No in Settings removes the steps', async ({ page }) => {
	await seedProfile(page, 208);
	await page.getByRole('button', { name: 'Yes', exact: true }).click();
	await expect(page.getByText(FIND)).toBeVisible();
	await page.goto('/settings');
	await page.getByRole('button', { name: /Planning SkillBridge/ }).click();
	await page.getByRole('radio', { name: 'No', exact: true }).click();
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByRole('button', { name: /Planning SkillBridge/ })).toHaveText(/No$/);
	await page.goto('/timeline');
	// The absence check below passes on an empty page, so it waits for the loaded task list first.
	await expect(page.locator('[id^="task-"]').first()).toBeVisible();
	await expect(page.getByText(FIND)).toHaveCount(0);
});

test('the card comes after Needs you now and before the calendar card', async ({ page }) => {
	await seedProfile(page, 208);
	const card = page.locator('.sb-card');
	await expect(card).toBeVisible();
	// The order helper passes when an element is absent, so the calendar card must be there for this to check anything.
	await expect(page.locator('.cal-card')).toBeVisible();
	const order = await page.evaluate(() => {
		const at = (sel: string) => document.querySelector(sel);
		const card = at('.sb-card');
		const before = at('section.needs-now');
		const after = at('.cal-card');
		const follows = (a: Element | null, b: Element | null) =>
			!a || !b || Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
		return { needsBefore: follows(before, card), calAfter: follows(card, after) };
	});
	expect(order).toEqual({ needsBefore: true, calAfter: true });
});

test('closing the answered message removes the card and moves focus to Add to my calendar', async ({
	page
}) => {
	await seedProfile(page, 208);
	const card = page.locator('.sb-card');
	await card.getByRole('button', { name: 'Yes', exact: true }).click();
	await expect(card.getByRole('status')).toHaveText(
		'SkillBridge steps added to your timeline. You can change this in Settings.'
	);
	// The frame fits its message: the card is the status line plus its own padding and border, with no fixed minimum.
	const fit = await page.evaluate(() => {
		const frame = document.querySelector<HTMLElement>('.sb-card');
		const line = frame?.querySelector<HTMLElement>('[role="status"]');
		if (!frame || !line) return null;
		const style = getComputedStyle(frame);
		const extra = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce(
			(sum, key) => sum + parseFloat(style[key as 'paddingTop']),
			0
		);
		return {
			frame: frame.getBoundingClientRect().height,
			expected: line.getBoundingClientRect().height + extra,
			inlineMinHeight: frame.style.minHeight
		};
	});
	expect(fit).not.toBeNull();
	expect(Math.abs((fit?.frame ?? 0) - (fit?.expected ?? 0))).toBeLessThanOrEqual(1);
	expect(fit?.inlineMinHeight).toBe('');
	// The focus check only means something while the calendar card, and so its Add button, is on the page.
	await expect(page.locator('.cal-card')).toBeVisible();
	// The calendar card has a button named Dismiss too, so this one is scoped to the SkillBridge card.
	await card.getByRole('button', { name: 'Dismiss' }).click();
	await expect(page.locator('.sb-card')).toHaveCount(0);
	await expect(page.locator('.cal-card__add')).toBeFocused();
});
