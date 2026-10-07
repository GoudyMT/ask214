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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** The timeline's "Mon D, YYYY" form of an ISO date. */
const longForm = (iso: string) => {
	const [year, month, day] = iso.split('-');
	return `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`;
};

/**
 * Every piece of personal text on the page, and the ones with no translate="no" ancestor. Personal text is any of
 * `values`, and - with `dates` - any date (the timeline's "Mon D, YYYY" or Settings' ISO form) or day count
 * ("208 days"). It is looked for in the page's text, its title (which can carry no attribute, so a personal title is
 * always unmarked), labelling attributes and - with `inputs` - input values.
 */
async function personalText(
	page: Page,
	options: { values: readonly string[]; dates: boolean; inputs: boolean }
): Promise<{ matched: string[]; unmarked: string[] }> {
	return page.evaluate(({ values, dates, inputs }) => {
		const personal = (text: string) =>
			(dates &&
				/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+ days?\b/.test(
					text
				)) ||
			values.some((value) => text.includes(value));
		const matched: string[] = [];
		const unmarked: string[] = [];
		const check = (text: string, element: Element | null) => {
			if (!personal(text)) return;
			matched.push(text.trim().slice(0, 80));
			if (!element?.closest('[translate="no"]')) unmarked.push(text.trim().slice(0, 80));
		};
		check(document.title, null);
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			check(node.textContent ?? '', node.parentElement);
		}
		if (inputs) {
			for (const field of document.querySelectorAll('input, textarea')) {
				check((field as HTMLInputElement).value, field);
			}
		}
		for (const element of document.querySelectorAll(
			'[title], [aria-label], [placeholder], [alt]'
		)) {
			for (const name of ['title', 'aria-label', 'placeholder', 'alt']) {
				check(element.getAttribute(name) ?? '', element);
			}
		}
		return { matched, unmarked };
	}, options);
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
	const separation = isoFromToday(208);
	const skillbridge = isoFromToday(28);
	const seeded = { values: [NOTE], dates: true, inputs: true };
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(separation);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();

	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await page.getByLabel('SkillBridge start').fill(skillbridge);
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
	const onTimeline = await personalText(page, seeded);
	expect(onTimeline.matched.some((text) => text.includes(longForm(skillbridge)))).toBe(true);
	expect(onTimeline.unmarked).toEqual([]);

	// An open date row shows the saved date as the input's value.
	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await expect(page.getByLabel('SkillBridge start')).toHaveValue(skillbridge);
	const onSettings = await personalText(page, seeded);
	expect(onSettings.matched.some((text) => text.includes(longForm(separation)))).toBe(true);
	expect(onSettings.unmarked).toEqual([]);
});

// The Ask view repeats a typed question back while it waits for the user's choice. The question has not been sent
// anywhere yet, so a page translation must not carry it off either: first at the online consent question, then at the
// on-device setup offer that "Stay on device" leads to. Every copy shown counts, not only the first; the Ask box's own
// value is left out (an accepted residual: whether a translation sends input values is unverified).
test('a question held for a choice stays out of page translation', async ({ page }) => {
	const question = 'What is SkillBridge?';
	const held = { values: [question], dates: false, inputs: false };
	await page.goto('/');
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await input.fill(question);
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(
		page.getByRole('heading', { name: /send your question to answer online/i })
	).toBeVisible();
	const atConsent = await personalText(page, held);
	expect(atConsent.matched.length).toBeGreaterThan(0);
	expect(atConsent.unmarked).toEqual([]);

	await page.getByRole('button', { name: /^stay on device$/i }).click();
	await expect(page.getByRole('heading', { name: /one-time setup/i })).toBeVisible();
	const atSetup = await personalText(page, held);
	expect(atSetup.matched.length).toBeGreaterThan(0);
	expect(atSetup.unmarked).toEqual([]);
});
