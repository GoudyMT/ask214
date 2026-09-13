import { expect, test, type Page } from '@playwright/test';

// The online Ask path is model-free (the server does retrieval), so these specs only intercept /api/retrieve
// with page.route. Block the service worker for this file: with it registered, webkit routes the /api/retrieve
// request through the SW and page.route never sees it (a Playwright + SW interaction), so the mock is bypassed
// and every online answer degrades. The SW is not what these specs exercise; blocking it lets the mock apply.
test.use({ serviceWorkers: 'block' });

// Must match the shipped corpus manifest version (static/corpus/corpus-v1.0.1.json): the client treats a server
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
	// consented device: this spec exercises the degrade path, not the first-egress gate (tested separately)
	await page.addInitScript(() => localStorage.setItem('mtc:ask:online-consented', '1'));
	await page.route('**/api/retrieve', (route) => route.fulfill({ status: 500, body: '' }));
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	// online is the default; asking hits the (failing) server and degrades onto the ladder
	await askInput(page).fill('How do I transfer my GI Bill?');
	await searchButton(page).click();
	await expect(page.getByText(/online is unavailable right now/i)).toBeVisible();
	await expect(page.getByRole('button', { name: /answer on your device/i })).toBeVisible();
});

test('the first online ask is held behind consent; Use online answers it and is remembered', async ({
	page
}) => {
	let retrieveCalls = 0;
	await page.route('**/api/retrieve', (route) => {
		retrieveCalls++;
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'results',
				corpusVersion: CORPUS_VERSION,
				results: [RESULT_HIT]
			})
		});
	});
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	// online is the default, but the first query is HELD - nothing egresses until the user consents
	await askInput(page).fill('What is SkillBridge?');
	await searchButton(page).click();
	await expect(page.getByText(/send your question to answer online/i)).toBeVisible();
	expect(retrieveCalls).toBe(0); // nothing sent before consent
	// consenting records the choice and answers the held query
	await page.getByRole('button', { name: /^use online$/i }).click();
	await expect(page.locator('.ask-card__title', { hasText: /DoD SkillBridge/i })).toBeVisible();
	await expect.poll(() => retrieveCalls).toBe(1);
	// consent is remembered on this device: a second ask egresses directly, no gate
	await askInput(page).fill('another question');
	await searchButton(page).click();
	await expect.poll(() => retrieveCalls).toBe(2);
	await expect(page.getByText(/send your question to answer online/i)).toHaveCount(0);
});

test('a user switch to online egresses nothing; the first ask is held at the consent gate', async ({
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
	await expect(page.getByText(/send your question to answer online/i)).toHaveCount(0); // the flip raises no gate
	expect(retrieveCalls).toBe(0); // and the switch itself egresses nothing
	// the first online ask is held at the consent gate - still nothing sent until the user confirms
	await askInput(page).fill('test question');
	await searchButton(page).click();
	await expect(page.getByText(/send your question to answer online/i)).toBeVisible();
	expect(retrieveCalls).toBe(0);
});

test('online: renders cited result cards from the server', async ({ page }) => {
	// consented device: this spec exercises card rendering, not the first-egress gate (tested separately)
	await page.addInitScript(() => localStorage.setItem('mtc:ask:online-consented', '1'));
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
	await expect(page.locator('.ask-card__title', { hasText: /DoD SkillBridge/i })).toBeVisible();
});

// Was: 'degrades to "summary unavailable"'. The graceful-degradation guarantee is unchanged - synthesis
// with no key must not blank the surface - but what it degrades TO is now the document's own sentences
// instead of an apology, so this asserts the answer rather than the absence of one.
test('synthesis enabled with no key falls back to the document answer and still shows the sources', async ({
	page
}) => {
	// Turn synthesis on (a non-PII device flag) but store no key: the route reads the key on demand, finds
	// none, and degrades gracefully rather than blanking.
	await page.addInitScript(() => {
		localStorage.setItem('mtc:ask:synthesis-enabled', '1');
		localStorage.setItem('mtc:ask:online-consented', '1'); // consented: exercise synthesis-degrade, not the gate
	});
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
	await expect(page.getByText(/What the source says/i)).toBeVisible(); // a real block, not an apology
	// Both tiers are in the DOM for the disclosure contract, so a bare text locator matches twice; scope to
	// the visible one. (Hidden nodes leave the accessibility tree, so nothing is announced twice.)
	await expect(page.locator('#ask-answer-short')).toContainText(/train with an employer/i);
	await expect(page.locator('.ask-card__title', { hasText: /DoD SkillBridge/i })).toBeVisible(); // the sources still render
	await expect(page.getByText(/summary unavailable/i)).toHaveCount(0);
});

// Sized against the selector's own budget, not by eye: the short answer targets 45 words and may reach a
// 1.5x ceiling of ~67, so a passage under that is returned WHOLE and tier 2 has nothing left to reveal.
// This one runs ~90 words with the query's terms in the first two sentences, so the selected run lands at
// the top and the tail below stays hidden until the user expands.
const LONG_HIT = {
	score: 0.9,
	chunk: {
		id: 'skillbridge_overview_long',
		text:
			'SkillBridge lets service members train with a civilian employer during their last 180 days of service. ' +
			'Participation requires unit commander approval before any agreement is signed. ' +
			'You continue to receive military pay and benefits throughout the program. ' +
			'The employer provides the training at no cost to the government. ' +
			'Programs vary widely in length, industry, and location across the country. ' +
			'Some are remote and some require relocation at your own expense. ' +
			'Your command may withdraw approval if mission requirements change. ' +
			// Filler that pushes the closing sentence past the 120-word tier-1 budget on purpose, so this
			// test exercises the EXPAND path. Tier 1 renders the lead card's opening up to 120 words, so a
			// chunk shorter than that is shown whole and offers no expansion at all - which is correct
			// behaviour, covered by the short-chunk test below.
			'Applications are submitted through your installation transition office well ahead of the start date. ' +
			'Each service sets its own additional eligibility rules on top of the department policy. ' +
			'Approval is never automatic and is evaluated against your unit manning and readiness. ' +
			'Talk to your career counselor early because the paperwork can take several weeks to clear. ' +
			'There is no guarantee of employment when the program ends.',
		sourceId: 'dod_skillbridge',
		sourceTitle: 'DoD SkillBridge',
		url: 'https://skillbridge.osd.mil/',
		tags: []
	}
};

// The whole point of the feature: a short answer in the document's own words, one tap from the fuller
// passage, on a path that needs no API key.
test('the answer block shows a short answer above the cards and expands to the fuller passage', async ({
	page
}) => {
	await page.addInitScript(() => localStorage.setItem('mtc:ask:online-consented', '1'));
	await page.route('**/api/retrieve', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'results',
				corpusVersion: CORPUS_VERSION,
				results: [LONG_HIT]
			})
		})
	);
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	await askInput(page).fill('does SkillBridge require commander approval?');
	await searchButton(page).click();

	const answer = page.locator('.ask-answer');
	await expect(answer).toBeVisible();
	await expect(answer).toContainText(/commander approval/i);
	// Both tiers live in the DOM for the disclosure contract, so assert VISIBILITY rather than presence.
	const passage = page.locator('#ask-answer-passage');
	await expect(passage).toBeHidden();
	const more = page.getByRole('button', { name: /more detail/i });
	await expect(more).toHaveAttribute('aria-expanded', 'false');

	await more.click();
	await expect(passage).toBeVisible();
	await expect(passage).toContainText(/no guarantee of employment/i);
	await expect(page.getByRole('button', { name: /show less/i })).toHaveAttribute(
		'aria-expanded',
		'true'
	);

	// The answer sits ABOVE the cards, and the lead card no longer repeats the same sentences underneath.
	await expect(page.locator('.ask-card--lead')).toBeVisible();
	await expect(page.locator('.ask-card--lead .ask-card__excerpt')).toHaveCount(0);
});

// The other half of the disclosure contract, and it covers the MAJORITY case. Tier 1 renders the lead card's
// opening up to 120 words, so any chunk shorter than that is shown in full and there is nothing left to
// expand to - measured at 53.3% of the 135 benchmark queries, because the government web pages that supply
// over half the answers have a 52-word median. Offering a control that reveals the same sentences again is a
// dead button, so the control must be ABSENT, not present-and-inert.
test('offers no expansion when the whole passage already fits in the answer', async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem('mtc:ask:online-consented', '1'));
	await page.route('**/api/retrieve', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({
				status: 'results',
				corpusVersion: CORPUS_VERSION,
				results: [
					{
						...LONG_HIT,
						chunk: {
							...LONG_HIT.chunk,
							id: 'skillbridge_short',
							text: 'SkillBridge participation requires unit commander approval before any agreement is signed.'
						}
					}
				]
			})
		})
	);
	await page.goto('/');
	await expect(askInput(page)).toBeEnabled();
	await askInput(page).fill('does SkillBridge require commander approval?');
	await searchButton(page).click();

	const answer = page.locator('.ask-answer');
	await expect(answer).toBeVisible();
	await expect(answer).toContainText(/commander approval/i);
	await expect(page.getByRole('button', { name: /more detail/i })).toHaveCount(0);
});
