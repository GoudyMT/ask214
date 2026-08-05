import { expect, test, type Page } from '@playwright/test';

// The online Ask path is model-free (the server does retrieval), so these specs only intercept /api/retrieve
// with page.route. Block the service worker for this file: with it registered, webkit routes the /api/retrieve
// request through the SW and page.route never sees it (a Playwright + SW interaction), so the mock is bypassed
// and every online answer degrades. The SW is not what these specs exercise; blocking it lets the mock apply.
test.use({ serviceWorkers: 'block' });

// Must match the shipped corpus manifest version (static/corpus/corpus-v1.0.json): the client treats a server
// answer on a different corpus version as unavailable, so the mock has to echo the exact version.
const CORPUS_VERSION = '1.0';

const askInput = (page: Page) => page.getByRole('textbox', { name: /ask a question/i });
const searchButton = (page: Page) => page.getByRole('button', { name: /^search$/i });

// A well-formed server hit (the full CorpusChunk shape the client narrows).
const RESULT_HIT = {
	score: 0.9,
	chunk: {
		id: 'skillbridge_overview',
		text: 'SkillBridge lets service members train with an employer during their last 180 days.',
		sourceId: 'dod_skillbridge',
		sourceTitle: 'DoD SkillBridge',
		url: 'https://skillbridge.osd.mil/',
		tags: []
	}
};

test('online default: a retrieve failure degrades to the on-device offer', async ({ page }) => {
	await page.route('**/api/retrieve', (route) => route.fulfill({ status: 500, body: '' }));
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	// online is the default; asking hits the (failing) server and degrades onto the ladder
	await askInput(page).fill('How do I transfer my GI Bill?');
	await searchButton(page).click();
	await expect(page.getByText(/online is unavailable right now/i)).toBeVisible();
	await expect(page.getByRole('button', { name: /answer on your device/i })).toBeVisible();
});

test('a device->online switch flips the mode and egresses nothing until the disclosed ask', async ({
	page
}) => {
	let retrieveCalls = 0;
	await page.route('**/api/retrieve', (route) => {
		retrieveCalls++;
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ status: 'empty', corpusVersion: CORPUS_VERSION })
		});
	});
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	// switch down to device, then back up to online: a user-initiated switch is a pure preference flip -
	// no blocking card, and the switch itself sends nothing (egress is the disclosed ask, not the toggle)
	await page.getByRole('button', { name: /^on device$/i }).click();
	await page.getByRole('button', { name: /^online$/i }).click();
	await expect(page.getByRole('button', { name: /^online$/i })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await expect(page.getByText(/answer online\?/i)).toHaveCount(0); // no blocking modal on the flip
	expect(retrieveCalls).toBe(0); // the switch itself egresses nothing
	// the disclosed ask (online mode + the honest privacy line) is the only egress
	await askInput(page).fill('test question');
	await searchButton(page).click();
	await expect.poll(() => retrieveCalls).toBeGreaterThan(0);
});

test('online: renders cited result cards from the server', async ({ page }) => {
	await page.route('**/api/retrieve', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'results',
				corpusVersion: CORPUS_VERSION,
				results: [RESULT_HIT]
			})
		})
	);
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	await askInput(page).fill('What is SkillBridge?');
	await searchButton(page).click();
	await expect(page.getByText(/DoD SkillBridge/i)).toBeVisible();
});

test('synthesis enabled with no key degrades to "summary unavailable" but still shows the sources', async ({
	page
}) => {
	// Turn synthesis on (a non-PII device flag) but store no key: the route reads the key on demand, finds
	// none, and degrades gracefully rather than blanking.
	await page.addInitScript(() => localStorage.setItem('mtc:ask:synthesis-enabled', '1'));
	await page.route('**/api/retrieve', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'results',
				corpusVersion: CORPUS_VERSION,
				results: [RESULT_HIT]
			})
		})
	);
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	await askInput(page).fill('What is SkillBridge?');
	await searchButton(page).click();
	await expect(page.getByText(/summary unavailable/i)).toBeVisible(); // no key -> graceful
	await expect(page.getByText(/DoD SkillBridge/i)).toBeVisible(); // the sources still render
});
