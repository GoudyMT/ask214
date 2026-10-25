import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';

// The PIN lock in a real browser, through the served build and its real key worker (Argon2id at the production
// tuple, about 1.5 s in Chromium and 2.5 s in WebKit per derive): turn it on, reload onto the Unlock card, count wrong
// tries across a reload, relock after a long absence, count a derive the OS killed, and keep the saved details off the
// network while locked. Nothing is stubbed; every detail is made up. The service worker is blocked so every request
// comes from the page itself.
test.use({ serviceWorkers: 'block' });
test.setTimeout(120_000);

const PIN = '135790';
const WRONG_PIN = '246802';
const MINUTE_MS = 60_000;

// Copied from egress-canary.e2e.ts: the E2E files share no helper module.
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Every form a date takes on screen or in a file: ISO, compact, and the timeline's "Mon D, YYYY". */
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

const SEPARATION = isoFromToday(300);
const SEPARATION_ON_SCREEN = dateForms(SEPARATION)[2] ?? '';
const ANCHORED = `Anchored to ${SEPARATION_ON_SCREEN}`;

const lockedHeading = (page: Page) => page.getByRole('heading', { name: 'Your data is locked' });
const pinField = (page: Page) => page.getByLabel('PIN', { exact: true });
const appLockToggle = (page: Page) => page.getByRole('button', { name: /^app lock/i });
const PIN_ON_LINE =
	'The app asks for your PIN when it opens, after 15 minutes idle, and after Lock.';
const NOT_RIGHT = 'That PIN is not right.';
const WAIT_LINE = /^That PIN is not right\. You can try again in \d+ seconds?\.$/;

/** The first-run wizard: a profile with one separation date, ending on the Timeline. */
async function setUpProfile(page: Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill(SEPARATION);
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

/** Settings -> App lock -> the PIN twice -> Next, to the "PIN on" row. One real derive and the move of every record. */
async function turnOnPin(page: Page, pin: string = PIN): Promise<void> {
	await page.goto('/settings');
	await appLockToggle(page).click();
	await page.getByLabel('Choose a 4-6 digit PIN').fill(pin);
	await page.getByLabel('Enter it again').fill(pin);
	await page.getByRole('button', { name: 'Next', exact: true }).click();
	await expect(appLockToggle(page)).toContainText('PIN on', { timeout: 30_000 });
	await expect(page.getByText(PIN_ON_LINE)).toBeVisible();
}

/** A move inside the open tab, so its keys stay: a fresh load of the address would ask for the PIN. */
async function openTimeline(page: Page): Promise<void> {
	await page.locator('header').getByRole('link', { name: 'Timeline' }).click();
	await expect(page.getByText(ANCHORED)).toBeVisible();
}

async function pressUnlock(page: Page, pin: string): Promise<void> {
	await pinField(page).fill(pin);
	await page.getByRole('button', { name: 'Unlock', exact: true }).click();
}

type Tries = { count: number; waitMs: number; pending: boolean } | null;

/** The wrong-try row of the app-lock store, read straight from IndexedDB. Null when no try was ever counted. */
async function readTriesRow(page: Page): Promise<Tries> {
	return page.evaluate(
		() =>
			new Promise<Tries>((resolve, reject) => {
				const open = indexedDB.open('mtc');
				open.onerror = () => reject(new Error('E_TEST_OPEN'));
				open.onsuccess = () => {
					const db = open.result;
					const get = db.transaction('app-lock', 'readonly').objectStore('app-lock').get('tries');
					get.onerror = () => reject(new Error('E_TEST_READ'));
					get.onsuccess = () => {
						db.close();
						const row = get.result as
							{ count: number; waitMs: number; pending: boolean } | undefined;
						resolve(row ? { count: row.count, waitMs: row.waitMs, pending: row.pending } : null);
					};
				};
			})
	);
}

// 1. The use: a person turns the PIN on, and the next time the app opens it asks.
test('turning the PIN on makes the next open ask for it, and the PIN opens the data again', async ({
	page
}) => {
	await setUpProfile(page);
	await turnOnPin(page);

	// Unlocked in the tab that turned it on: the data is on screen before the reload.
	await openTimeline(page);
	await page.reload();

	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByText('Enter your PIN to open your information.')).toBeVisible();
	await expect(page.getByText(/Anchored to/)).toHaveCount(0);
	await expect(page.getByText(SEPARATION_ON_SCREEN)).toHaveCount(0);
	// The card is the whole answer: no first-run wizard, and no start-up banner.
	await expect(page).toHaveURL(/\/timeline$/);
	await expect(page.locator('.init-banner')).toHaveCount(0);

	// The same on Home, where a locked tab with a saved profile must not offer the first-run setup.
	await page.goto('/');
	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByRole('heading', { name: /make it yours/i })).toHaveCount(0);
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toHaveCount(0);
	await expect(page.locator('.init-banner')).toHaveCount(0);

	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();
	await pressUnlock(page, PIN);
	await expect(page.getByText(ANCHORED)).toBeVisible({ timeout: 30_000 });
	await expect(lockedHeading(page)).toHaveCount(0);
});

// 2. The use: someone guessing at the PIN is slowed, and a reload does not give the tries back.
test('wrong tries and the wait they earn survive a reload, and the right PIN opens after the wait', async ({
	page
}) => {
	// Installed before the page loads, so the app's performance.now and Date.now both move with the test's clock.
	await page.clock.install();
	await setUpProfile(page);
	await turnOnPin(page);
	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();

	for (const tries of [1, 2, 3]) {
		await pressUnlock(page, WRONG_PIN);
		await expect
			.poll(() => readTriesRow(page), { timeout: 30_000 })
			.toMatchObject({
				count: tries,
				pending: false
			});
		await expect(page.getByRole('alert')).toHaveText(NOT_RIGHT);
	}
	// The 4th wrong try owes the first wait.
	await pressUnlock(page, WRONG_PIN);
	await expect(page.getByRole('alert')).toHaveText(
		'That PIN is not right. You can try again in 30 seconds.',
		{ timeout: 30_000 }
	);
	expect(await readTriesRow(page)).toMatchObject({ count: 4, pending: false });

	// A reload is not a way round it: the wait is still owed, and the right PIN is not even tried.
	await page.reload();
	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByRole('alert')).toHaveText(WAIT_LINE);
	await pressUnlock(page, PIN);
	await expect(page.getByRole('alert')).toHaveText(WAIT_LINE);
	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByText(/Anchored to/)).toHaveCount(0);
	expect(await readTriesRow(page)).toMatchObject({ count: 4, pending: false });

	// Past the wait, on both clocks at once, and the stored remainder is written down.
	await page.clock.fastForward('00:35');
	await expect.poll(() => readTriesRow(page)).toMatchObject({ count: 4, waitMs: 0 });
	await expect(page.getByRole('alert')).toHaveCount(0);
	await pressUnlock(page, PIN);
	await expect(page.getByText(ANCHORED)).toBeVisible({ timeout: 30_000 });
	// A good PIN gives the tries back.
	await expect
		.poll(() => readTriesRow(page))
		.toMatchObject({ count: 0, waitMs: 0, pending: false });
});

// 3. The use: a phone left for a long time asks for the PIN on the way back, by every way back, and a short look away
// does not. The phone's wall clock is moved while the page's timers stay still: a sleeping phone runs none, so only the
// check on the way back can lock it.
type Way = { out: () => void; back: () => void };

const HIDDEN_AND_VISIBLE: Way = {
	out: () => {
		Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	},
	back: () => {
		Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
		document.dispatchEvent(new Event('visibilitychange'));
	}
};

const WAYS_OUT_AND_BACK: Record<string, Way> = {
	'the page becoming hidden and visible again': HIDDEN_AND_VISIBLE,
	'a pagehide and a persisted pageshow': {
		out: () => {
			window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
		},
		back: () => {
			window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
		}
	},
	'a freeze and a resume': {
		out: () => {
			document.dispatchEvent(new Event('freeze'));
		},
		back: () => {
			document.dispatchEvent(new Event('resume'));
		}
	}
};

async function awayFor(page: Page, way: Way, minutes: number): Promise<void> {
	await page.evaluate(way.out);
	const now = await page.evaluate(() => Date.now());
	await page.clock.setSystemTime(now + minutes * MINUTE_MS);
	await page.evaluate(way.back);
}

for (const [name, way] of Object.entries(WAYS_OUT_AND_BACK)) {
	test(`sixteen minutes away asks for the PIN on the way back: ${name}`, async ({ page }) => {
		await page.clock.install();
		await setUpProfile(page);
		await turnOnPin(page);
		await openTimeline(page);

		await awayFor(page, way, 16);

		await expect(pinField(page)).toBeVisible();
		await expect(lockedHeading(page)).toBeVisible();
		await expect(page.getByText(/Anchored to/)).toHaveCount(0);
	});
}

test('one minute away asks for nothing: the data is still open on the way back', async ({
	page
}) => {
	await page.clock.install();
	await setUpProfile(page);
	await turnOnPin(page);
	await openTimeline(page);

	await awayFor(page, HIDDEN_AND_VISIBLE, 1);

	await expect(page.getByText(ANCHORED)).toBeVisible();
	await expect(pinField(page)).toHaveCount(0);
	await expect(lockedHeading(page)).toHaveCount(0);
});

// 4. The use: guessing cannot be made free by killing the derive. The try is written before the derive starts, so a tab
// the OS killed mid-derive has still counted it.
test('a derive that never finished still counts as a try', async ({ page, context }) => {
	await setUpProfile(page);
	await turnOnPin(page);
	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();
	expect(await readTriesRow(page)).toBeNull();

	// From here the key worker starts but never answers, so the derive is in flight until the page goes.
	await context.route('**/backup-kdf/**', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'text/javascript',
			body: 'self.onmessage = () => {};'
		})
	);
	await pressUnlock(page, PIN);
	await expect.poll(() => readTriesRow(page)).toMatchObject({ count: 1, pending: true });
	await expect(page.getByRole('button', { name: 'Unlocking...' })).toBeVisible();
	await page.close();

	const reopened = await context.newPage();
	await reopened.goto('/timeline');
	await expect(lockedHeading(reopened)).toBeVisible();
	expect(await readTriesRow(reopened)).toMatchObject({ count: 1, pending: true });
	await expect(reopened.getByText(/Anchored to/)).toHaveCount(0);
});

// 5. The use: a locked phone shows nothing and sends nothing. Every request from the first set-up to the unlock is read
// for the saved details, the PIN and the question typed into Ask, in each form they take on the wire.
const CONTROL_PATH = '/api/e2e-control';
const CONTROL_MARKER = 'egress-control-marker-0042';

/** Refuses every /api/ request and lists the ones that got that far, then proves the refusal with one of its own. */
async function sealApi(context: BrowserContext, page: Page): Promise<string[]> {
	const reached: string[] = [];
	await context.route('**/api/**', (route) => {
		reached.push(new URL(route.request().url()).pathname);
		return route.abort();
	});
	await page.goto('/');
	const outcome = await page.evaluate(
		({ path, marker }) =>
			fetch(path, { method: 'POST', body: marker }).then(
				() => 'reached the network',
				() => 'refused'
			),
		{ path: CONTROL_PATH, marker: CONTROL_MARKER }
	);
	expect(outcome).toBe('refused');
	expect(reached).toEqual([CONTROL_PATH]);
	return reached;
}

test('while locked, nothing saved, no PIN and no question leaves the page', async ({
	page,
	context
}) => {
	const SKILLBRIDGE = isoFromToday(180);
	const NOTE = 'Canary note about Fennimore Quay that must stay on this device';
	const QUESTION = 'Where is the Brindlemoor Harbour Annex';
	const requests: Request[] = [];
	context.on('request', (request) => requests.push(request));
	const reached = await sealApi(context, page);

	// Details in three stores: the profile, the timeline's own state and the saved note.
	await setUpProfile(page);
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
	await turnOnPin(page);

	// Reload onto each locked screen, then ask on the device from Home, then unlock.
	await page.goto('/timeline');
	await expect(lockedHeading(page)).toBeVisible();
	await expect(page.getByText(NOTE)).toHaveCount(0);
	await page.goto('/settings');
	await expect(lockedHeading(page)).toBeVisible();
	await page.goto('/');
	await expect(lockedHeading(page)).toBeVisible();
	const input = page.getByRole('textbox', { name: /ask a question/i });
	await expect(input).toBeEnabled();
	await page.getByRole('button', { name: /^on device$/i }).click();
	await input.fill(QUESTION);
	await page.getByRole('button', { name: /^search$/i }).click();
	await expect(page.getByText(/one-time setup to answer your question/i)).toBeVisible();
	await expect(lockedHeading(page)).toBeVisible();
	await pressUnlock(page, PIN);
	await expect(lockedHeading(page)).toHaveCount(0, { timeout: 30_000 });

	const sent = await Promise.all(
		requests.map(async (request) => ({
			url: request.url(),
			body: request.postData() ?? '',
			headers: JSON.stringify(await request.allHeaders())
		}))
	);
	const readable = (r: { url: string; body: string; headers: string }) =>
		[r.url, decoded(r.url), r.body, decoded(r.body), r.headers].join('\n');

	// The control for the scan itself: it sees a body, so an absent value is absent and not unread.
	expect(
		sent.some((r) => readable(r).includes(CONTROL_MARKER)),
		'the scan reads the control request'
	).toBe(true);
	// And the seal held: the only /api/ request in the whole run is the control.
	expect(reached).toEqual([CONTROL_PATH]);

	const personal = [...dateForms(SEPARATION), ...dateForms(SKILLBRIDGE), NOTE, QUESTION, PIN];
	for (const request of sent) {
		const text = readable(request);
		for (const value of personal) {
			expect(text, `${value} in ${request.url}`).not.toContain(value);
		}
	}
});
