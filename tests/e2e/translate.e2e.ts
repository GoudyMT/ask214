import { expect, test, type Page } from '@playwright/test';

// A browser's page translation (Safari's; Chrome's whenever the page's language differs from the browser's) sends the
// page's text to a translation service. The screens that show the separation date, the leaving dates or task dates
// worked out from them mark their content translate="no"; the public screens stay translatable for readers who need
// them.

// Copied from leaving-command.e2e.ts: the E2E files share no helper module. Seeded relative to today, because the app's
// today is the device clock's local date.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const NOTE = 'Canary note for the translation check';

/**
 * Every date (the timeline's "Mon D, YYYY" or Settings' ISO form) or the canary note shown on the page - in text,
 * an input's value or a labelling attribute - that has no translate="no" ancestor, plus how many were found at all,
 * so a page with nothing personal on it cannot pass.
 */
async function unmarkedPersonalText(page: Page): Promise<{ found: number; unmarked: string[] }> {
	return page.evaluate((note) => {
		const personal = (text: string) =>
			/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}\b/.test(
				text
			) || text.includes(note);
		let found = 0;
		const unmarked: string[] = [];
		const check = (text: string, element: Element | null) => {
			if (!personal(text)) return;
			found++;
			if (!element?.closest('[translate="no"]')) unmarked.push(text.trim().slice(0, 80));
		};
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			check(node.textContent ?? '', node.parentElement);
		}
		for (const field of document.querySelectorAll('input, textarea')) {
			check((field as HTMLInputElement).value, field);
		}
		for (const element of document.querySelectorAll(
			'[title], [aria-label], [placeholder], [alt]'
		)) {
			for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
				check(element.getAttribute(name) ?? '', element);
			}
		}
		return { found, unmarked };
	}, NOTE);
}
const PERSONAL: ReadonlyArray<[path: string, heading: string]> = [
	['/timeline', 'Timeline'],
	['/settings', 'Settings'],
	['/wizard', 'Set up your profile']
];
const PUBLIC = ['/', '/documents', '/about'];

for (const [path, heading] of PERSONAL) {
	test(`${path} keeps its content out of page translation`, async ({ page }) => {
		await page.goto(path);
		const h1 = page.getByRole('heading', { level: 1, name: heading });
		await expect(h1).toBeVisible();
		await expect(h1.locator('xpath=ancestor::*[@translate="no"]')).toHaveCount(1);
	});
}

for (const path of PUBLIC) {
	test(`${path} stays translatable`, async ({ page }) => {
		await page.goto(path);
		await expect(page.locator('main#main-content')).toBeVisible();
		await expect(page.locator('[translate="no"]')).toHaveCount(0);
	});
}

test('every personal date and note on Timeline and Settings sits in an untranslated container', async ({
	page
}) => {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(208));
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await page.getByLabel('SkillBridge start').fill(isoFromToday(28));
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByLabel('SkillBridge start')).toBeHidden(); // the row closes once the date is saved

	await page.goto('/timeline');
	await expect(page.getByText(/^SkillBridge from /)).toBeVisible();
	await page.getByRole('button', { name: 'Add note' }).first().click();
	await page.locator('.task-card__note-input').fill(NOTE);
	await page
		.locator('.task-card__note-actions')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByText(NOTE)).toBeVisible();
	const onTimeline = await unmarkedPersonalText(page);
	expect(onTimeline.found).toBeGreaterThan(0);
	expect(onTimeline.unmarked).toEqual([]);

	// An open date row shows the saved date as the input's value.
	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await expect(page.getByLabel('SkillBridge start')).toHaveValue(isoFromToday(28));
	const onSettings = await unmarkedPersonalText(page);
	expect(onSettings.found).toBeGreaterThan(0);
	expect(onSettings.unmarked).toEqual([]);
});

// The Ask view repeats a typed question back while it waits for the user's choice. The question has not been sent
// anywhere yet, so a page translation must not carry it off either: first at the online consent question, then at the
// on-device setup offer that "Stay on device" leads to.
test('a question held for a choice stays out of page translation', async ({ page }) => {
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await input.fill('What is SkillBridge?');
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(
		page.getByRole('heading', { name: /send your question to answer online/i })
	).toBeVisible();
	const atConsent = page.getByText('"What is SkillBridge?"');
	await expect(atConsent.locator('xpath=ancestor-or-self::*[@translate="no"]')).toHaveCount(1);

	await page.getByRole('button', { name: /^stay on device$/i }).click();
	await expect(page.getByRole('heading', { name: /one-time setup/i })).toBeVisible();
	const atSetup = page.getByText('"What is SkillBridge?"');
	await expect(atSetup.locator('xpath=ancestor-or-self::*[@translate="no"]')).toHaveCount(1);
});
