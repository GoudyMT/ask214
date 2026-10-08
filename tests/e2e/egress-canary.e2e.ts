import { expect, test, type Request } from '@playwright/test';

// Every request the page sends during this flow - to our own server, to Anthropic, for any file - checked for the
// user's own data. The guard in src/lib/ci/pii-policy.ts reads names and imports; this reads values: the separation and
// SkillBridge dates in each form the app shows (ISO, compact, "Mon D, YYYY"), the day count it shows ("208 days"), a
// task note, the SkillBridge answer (its stored key, its value and the day a Not sure brings the question back), and
// the user's own API key, which may go to Anthropic and nowhere else. URLs and bodies are also read
// decoded, so an encoded value is still found, and the headers include cookies. A value changed some other way (a sum,
// a hash) is outside what a string check can see. The service worker is blocked so every request comes from the page
// itself (a registered worker handles WebKit's fetches before a mock applies).
test.use({ serviceWorkers: 'block' });

// Must match the shipped corpus manifest version: the client treats an answer on another version as unavailable.
const CORPUS_VERSION = '1.0.2';
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

// Copied from leaving-command.e2e.ts: the E2E files share no helper module.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every form a date takes on screen or in a file: ISO, compact (the calendar file), and the timeline's "Mon D, YYYY". */
function dateForms(iso: string): string[] {
	const [year, month, day] = iso.split('-');
	return [iso, iso.replace(/-/g, ''), `${MONTHS[Number(month) - 1]} ${Number(day)}, ${year}`];
}

/** A URL or form body read as the server would read it; unchanged when it is not validly encoded. */
function decoded(text: string): string {
	try {
		return decodeURIComponent(text.replace(/\+/g, ' '));
	} catch {
		return text;
	}
}

// The SkillBridge question asks again this many days before separation (about 15 months); an early Not sure stores that day.
const ASK_AGAIN_DAYS = 456;
const DAYS_TO_SEPARATION = 208;
const SEPARATION = isoFromToday(DAYS_TO_SEPARATION);
const SKILLBRIDGE = isoFromToday(28);
const NOTE = 'Canary note that must stay on this device';
const QUESTION = 'What is SkillBridge?';
// The titles of the two steps a Yes (or a late Not sure) adds to the timeline, as the task list shows them.
const FIND_TITLE = 'Find a SkillBridge program and get an acceptance letter';
const REQUEST_TITLE =
	"Submit your SkillBridge request (MyNavy Education and your command's package)";
// A made-up key in Anthropic's format; the request carrying it is answered by the mock below and never leaves.
const TEST_KEY = 'sk-ant-test-canary-0000';
const ANTHROPIC = 'https://api.anthropic.com/';

test('no personal value reaches an online request', async ({ page, browserName }) => {
	const requests: Request[] = [];
	page.on('request', (request) => requests.push(request));
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
	await page.route(`${ANTHROPIC}**`, (route) => route.fulfill({ status: 500, body: '' }));
	await page.route('**/api/feedback', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
	);

	// The user's own data: a separation date, a SkillBridge start and a task note.
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(SEPARATION);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await page.goto('/settings');
	await page.getByRole('button', { name: /skillbridge start/i }).click();
	await page.getByLabel('SkillBridge start').fill(SKILLBRIDGE);
	await page
		.getByLabel('Transition timeline')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByLabel('SkillBridge start')).toBeHidden();
	await page.goto('/timeline');
	await page.getByRole('button', { name: 'Add note' }).first().click();
	await page.locator('.task-card__note-input').fill(NOTE);
	await page
		.locator('.task-card__note-actions')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByText(NOTE)).toBeVisible();
	// The SkillBridge answer: a Not sure here (past the second ask) shows the steps and saves a status-only snooze.
	await page.locator('.sb-card').getByRole('button', { name: 'Not sure', exact: true }).click();
	await expect(page.getByText(FIND_TITLE)).toBeVisible();
	await expect(page.getByText(REQUEST_TITLE)).toBeVisible();

	// The written summary on, with a key, so the request to Anthropic is made too.
	await page.goto('/settings');
	await page.getByLabel(/add an ai-written summary/i).check();
	await page.getByLabel('Your Anthropic API key').fill(TEST_KEY);
	await page
		.locator('.online-key')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByLabel('Your Anthropic API key')).toHaveAttribute(
		'placeholder',
		'A key is stored'
	);

	// An online question, through the consent question, and a feedback message.
	await page.goto('/');
	await page.getByRole('textbox', { name: /ask a question/i }).fill(QUESTION);
	await page.getByRole('button', { name: /^search$/i }).click();
	await page.getByRole('button', { name: /^use online$/i }).click();
	await expect(page.locator('.ask-card__title', { hasText: /DoD SkillBridge/i })).toBeVisible();
	// WebKit's test browser makes no summary request: the app's key read returns nothing there although the stored key
	// row is present. Until that is explained, Chromium carries the summary request's checks; both engines carry the
	// rest.
	if (browserName === 'chromium') {
		await expect.poll(() => requests.some((r) => r.url().startsWith(ANTHROPIC))).toBe(true);
	}
	await page.goto('/feedback');
	await page.getByLabel('Your message').fill('the timeline page looked off');
	await page.getByRole('button', { name: 'Send feedback' }).click();
	await expect(page.getByText(/your feedback was sent/i)).toBeVisible();

	const sent = await Promise.all(
		requests.map(async (request) => ({
			url: request.url(),
			body: request.postData() ?? '',
			headers: JSON.stringify(await request.allHeaders())
		}))
	);
	const retrieve = sent.filter((r) => r.url.includes('/api/retrieve'));
	expect(retrieve).toHaveLength(1);
	expect(JSON.parse(retrieve[0]?.body ?? '')).toEqual({ query: QUESTION });
	expect(sent.some((r) => r.url.includes('/api/feedback'))).toBe(true);

	const personal = [
		...dateForms(SEPARATION),
		...dateForms(SKILLBRIDGE),
		`${DAYS_TO_SEPARATION} days`,
		NOTE,
		// This Not sure is late, so the app stores no return day; the day stays forbidden so a regression that did store
		// one (and then sent it) is caught here.
		...dateForms(isoFromToday(DAYS_TO_SEPARATION - ASK_AGAIN_DAYS)),
		// The saved answer's key and value, and the two steps it adds to the timeline: which steps a person's timeline
		// holds reveals the answer, so neither their ids nor their titles may travel.
		'skillbridge-plan',
		'not-sure',
		'skillbridge-find',
		'skillbridge-request',
		FIND_TITLE,
		REQUEST_TITLE
	];
	for (const request of sent) {
		const text = [
			request.url,
			decoded(request.url),
			request.body,
			decoded(request.body),
			request.headers
		].join('\n');
		for (const value of personal) {
			expect(text, `${value} in ${request.url}`).not.toContain(value);
		}
		if (!request.url.startsWith(ANTHROPIC)) {
			expect(text, `the API key in ${request.url}`).not.toContain(TEST_KEY);
		}
	}
	// The control for the key check: on Chromium the key does travel, to Anthropic only, and the check can see it.
	if (browserName === 'chromium') {
		expect(sent.some((r) => r.url.startsWith(ANTHROPIC) && r.headers.includes(TEST_KEY))).toBe(
			true
		);
	}
});

// Far enough out that a Not sure is early: the app stores the day the question comes back, a date the first flow never
// stores.
const EARLY_DAYS_TO_SEPARATION = ASK_AGAIN_DAYS + 176;

test('an early Not sure keeps its stored return date on this device', async ({
	page,
	browserName
}) => {
	const requests: Request[] = [];
	page.on('request', (request) => requests.push(request));
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
	await page.route(`${ANTHROPIC}**`, (route) => route.fulfill({ status: 500, body: '' }));
	await page.route('**/api/feedback', (route) =>
		route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
	);

	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(isoFromToday(EARLY_DAYS_TO_SEPARATION));
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
	await page.locator('.sb-card').getByRole('button', { name: 'Not sure', exact: true }).click();
	// The exact line, with the day built from the test's own copy of the ask-again offset: if the app's offset changes,
	// the screen no longer names this day and the test fails, so the copy cannot drift unnoticed.
	const returns = dateForms(isoFromToday(EARLY_DAYS_TO_SEPARATION - ASK_AGAIN_DAYS))[2];
	await expect(page.getByRole('status')).toHaveText(
		`We'll ask again on ${returns}. You can change this in Settings.`
	);

	// The same online paths as the flow above: a written summary with a key, an online question, a feedback message.
	await page.goto('/settings');
	await page.getByLabel(/add an ai-written summary/i).check();
	await page.getByLabel('Your Anthropic API key').fill(TEST_KEY);
	await page
		.locator('.online-key')
		.getByRole('button', { name: /^save$/i })
		.click();
	await expect(page.getByLabel('Your Anthropic API key')).toHaveAttribute(
		'placeholder',
		'A key is stored'
	);
	await page.goto('/');
	await page.getByRole('textbox', { name: /ask a question/i }).fill(QUESTION);
	await page.getByRole('button', { name: /^search$/i }).click();
	await page.getByRole('button', { name: /^use online$/i }).click();
	await expect(page.locator('.ask-card__title', { hasText: /DoD SkillBridge/i })).toBeVisible();
	if (browserName === 'chromium') {
		await expect.poll(() => requests.some((r) => r.url().startsWith(ANTHROPIC))).toBe(true);
	}
	await page.goto('/feedback');
	await page.getByLabel('Your message').fill('the timeline page looked off');
	await page.getByRole('button', { name: 'Send feedback' }).click();
	await expect(page.getByText(/your feedback was sent/i)).toBeVisible();

	const sent = await Promise.all(
		requests.map(async (request) => ({
			url: request.url(),
			body: request.postData() ?? '',
			headers: JSON.stringify(await request.allHeaders())
		}))
	);
	expect(sent.some((r) => r.url.includes('/api/retrieve'))).toBe(true);
	expect(sent.some((r) => r.url.includes('/api/feedback'))).toBe(true);

	const personal = [
		...dateForms(isoFromToday(EARLY_DAYS_TO_SEPARATION)),
		...dateForms(isoFromToday(EARLY_DAYS_TO_SEPARATION - ASK_AGAIN_DAYS)),
		`${EARLY_DAYS_TO_SEPARATION} days`,
		'skillbridge-plan',
		'not-sure'
	];
	for (const request of sent) {
		const text = [
			request.url,
			decoded(request.url),
			request.body,
			decoded(request.body),
			request.headers
		].join('\n');
		for (const value of personal) {
			expect(text, `${value} in ${request.url}`).not.toContain(value);
		}
	}
});
