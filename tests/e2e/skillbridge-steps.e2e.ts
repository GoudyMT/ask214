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
	await expect(page.getByRole('heading', { name: 'Planning to do SkillBridge?' })).toBeVisible();
	await expect(page.getByText(FIND)).toHaveCount(0);
	await page
		.getByRole('group', { name: 'Planning to do SkillBridge?' })
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
	const close = page.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true });
	await expect(close).toHaveCount(1);
	await close.click();
	await expect(page.locator('.sb-card')).toHaveCount(0);
	await expect(page.locator('.cal-card__add')).toBeFocused();
});

// The app header is sticky; focus() scrolls a target only to the viewport's edge, which is under that header.
for (const how of ['Enter', 'tap'] as const) {
	test(`the status line clears the sticky header after ${how} on an answer with the card's top scrolled away`, async ({
		page
	}) => {
		await page.setViewportSize({ width: 320, height: 640 });
		await seedProfile(page, 208);
		const yes = page.locator('.sb-card').getByRole('button', { name: 'Yes', exact: true });
		await expect(yes).toBeVisible();
		await page.evaluate(() => {
			const card = document.querySelector('.sb-card');
			if (card) window.scrollBy(0, card.getBoundingClientRect().top + 60);
		});
		// The set-up only means something while the pills are still in view below the header.
		const before = await page.evaluate(() => ({
			cardTop: document.querySelector('.sb-card')?.getBoundingClientRect().top ?? NaN,
			yesTop:
				document.querySelector('.sb-card__answers button')?.getBoundingClientRect().top ?? NaN,
			headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? NaN
		}));
		expect(Math.abs(before.cardTop + 60)).toBeLessThanOrEqual(2);
		expect(before.yesTop).toBeGreaterThanOrEqual(before.headerBottom);
		if (how === 'Enter') {
			await yes.focus();
			await page.keyboard.press('Enter');
		} else {
			await yes.click();
		}
		const line = page.locator('.sb-card').getByRole('status');
		await expect(line).toBeFocused();
		const after = await page.evaluate(() => ({
			lineTop: document.querySelector('.sb-card__done')?.getBoundingClientRect().top ?? NaN,
			headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? NaN
		}));
		expect(after.lineTop).toBeGreaterThanOrEqual(after.headerBottom);
	});
}

test('the close x clears the sticky header when Tab reaches it from the status line with the card scrolled away', async ({
	page
}) => {
	await page.setViewportSize({ width: 320, height: 640 });
	await seedProfile(page, 208);
	await page.locator('.sb-card').getByRole('button', { name: 'Yes', exact: true }).click();
	await expect(page.locator('.sb-card').getByRole('status')).toBeFocused();
	await page.evaluate(() => {
		const card = document.querySelector('.sb-card');
		if (card) window.scrollBy(0, card.getBoundingClientRect().top + 30);
	});
	await page.keyboard.press('Tab');
	const close = page.getByRole('button', { name: 'Dismiss SkillBridge message', exact: true });
	await expect(close).toBeFocused();
	const rects = await page.evaluate(() => ({
		closeTop: document.querySelector('.sb-card__close')?.getBoundingClientRect().top ?? NaN,
		headerBottom: document.querySelector('header')?.getBoundingClientRect().bottom ?? NaN
	}));
	expect(rects.closeTop).toBeGreaterThanOrEqual(rects.headerBottom);
});

// Closing the card moves the calendar card up under the same spot, and moves focus to its Add button: a second tap or
// key on the x lands on the calendar card instead.
const CLOSE_NAME = 'Dismiss SkillBridge message';

async function answerYesAndFindClose(page: Page) {
	await seedProfile(page, 300);
	await page.locator('.sb-card').getByRole('button', { name: 'Yes', exact: true }).click();
	const close = page.getByRole('button', { name: CLOSE_NAME, exact: true });
	await expect(close).toBeVisible();
	// The absence checks after the close pass on an empty page, so the calendar card must be there to be acted on.
	await expect(page.locator('.cal-card')).toBeVisible();
	return close;
}

test('a second tap on the closed card x does not dismiss the calendar card', async ({ page }) => {
	const close = await answerYesAndFindClose(page);
	const box = await close.boundingBox();
	expect(box).not.toBeNull();
	const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
	const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
	await page.mouse.click(x, y);
	await page.waitForTimeout(200);
	await page.mouse.click(x, y);
	await expect(page.locator('.sb-card')).toHaveCount(0);
	// A dismissal takes the card off the page at once; the reload then shows whether one was saved.
	await page.waitForTimeout(300);
	await expect(page.locator('.cal-card')).toHaveCount(1);
	await page.reload();
	await expect(page.locator('[id^="task-"]').first()).toBeVisible();
	await expect(page.locator('.cal-card')).toHaveCount(1);
});

test('a deliberate tap on the calendar card x after the close still dismisses it', async ({
	page
}) => {
	const close = await answerYesAndFindClose(page);
	await close.click();
	await expect(page.locator('.sb-card')).toHaveCount(0);
	await page.waitForTimeout(600);
	await page.locator('.cal-card').getByRole('button', { name: 'Dismiss', exact: true }).click();
	await expect(page.locator('.cal-card')).toHaveCount(0);
	await page.reload();
	await expect(page.locator('[id^="task-"]').first()).toBeVisible();
	await expect(page.locator('.cal-card')).toHaveCount(0);
});

for (const key of ['Enter', 'Space'] as const) {
	test(`${key} twice on the closed card x does not download the calendar file`, async ({
		page
	}) => {
		const files: string[] = [];
		page.on('download', (d) => files.push(d.suggestedFilename()));
		const close = await answerYesAndFindClose(page);
		await close.focus();
		await page.keyboard.press(key);
		await page.keyboard.press(key);
		await expect(page.locator('.sb-card')).toHaveCount(0);
		// A download that never starts cannot be waited for, so the wait is a fixed pause past the close.
		await page.waitForTimeout(400);
		expect(files).toEqual([]);
		await expect(page.locator('.cal-card')).toHaveCount(1);
	});
}

test('Enter on Add to my calendar after the close does download the file', async ({ page }) => {
	const close = await answerYesAndFindClose(page);
	await close.focus();
	await page.keyboard.press('Enter');
	await expect(page.locator('.sb-card')).toHaveCount(0);
	await expect(page.locator('.cal-card__add')).toBeFocused();
	await page.waitForTimeout(600);
	// Read through the download object only: nothing is saved to disk.
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page.keyboard.press('Enter')
	]);
	expect(download.suggestedFilename()).toMatch(/^ask214-deadlines-.+\.ics$/);
});
