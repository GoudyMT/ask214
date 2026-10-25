import { createRawSnippet, tick } from 'svelte';
import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { chooseAnswer, toExtractiveAnswer } from '$lib/ask/answer/answer-view';
import { detectEligibilityIntent } from '$lib/ask/synthesis/eligibility-gate';
import type { AskState } from '$lib/ask';
import { createByokStore } from '$lib/ask/byok/store';
import { KDF_V1 } from '$lib/backup/kdf-params';
import { createCalendarSyncStore } from '$lib/calendar/store.svelte';
import type { ResultCard } from '$lib/corpus';
import { deleteTestDb, openTestDb } from '$lib/db/_test-helpers';
import { reqToPromise, withStores, type StoreName } from '$lib/db/schema';
import { bootstrapLocalKeystore } from '$lib/keystore/bootstrap';
import { readCounter } from '$lib/keystore/app-lock-store';
import type { KeystoreRecordPin } from '$lib/keystore/record';
import { rotateToPin } from '$lib/keystore/rotate';
import {
	dropSession,
	openPinSession,
	setOnSessionMismatch,
	setSession
} from '$lib/keystore/session';
import type { ProfileApp } from '$lib/profile/context';
import { encodeEaos, parseEaosAtRead } from '$lib/profile/eaos';
import { createProfileStore } from '$lib/profile/store.svelte';
import { cleanListing } from '$lib/skillbridge-finder/fixtures/clean';
import { createFinderPackStore } from '$lib/skillbridge-finder/state/pack-store.svelte';
import { createFinderStore } from '$lib/skillbridge-finder/state/store.svelte';
import { localTodayIso } from '$lib/timeline/day-math';
import { KNOWN_TASK_IDS } from '$lib/timeline/known-task-ids';
import { createTimelineStateStore } from '$lib/timeline/state.svelte';
import DocumentsPage from './documents/+page.svelte';
import HomePage from './+page.svelte';
import Layout from './+layout.svelte';
import ResourcesPage from './resources/+page.svelte';
import SettingsPage from './settings/+page.svelte';
import TimelinePage from './timeline/+page.svelte';

// The real layout starts up on a test database that holds a PIN device with a saved record in every encrypted store, and
// the tab has no session (a reload). A page is then drawn on that app. The Ask store alone is a stand-in the test steers,
// so a question and its answer are whatever the case says they are.
const harness = vi.hoisted(() => ({
	db: null as Promise<IDBDatabase> | null,
	app: null as ProfileApp | null,
	// When set, stands in for the PIN check (the derive is Argon2id in a worker); otherwise the real one runs.
	check: null as null | (() => Promise<unknown>),
	// When set, Home gets the real Ask store.
	realAsk: false
}));

vi.mock('$lib/db/schema', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/db/schema')>();
	return {
		...real,
		openMtcDb: (...args: Parameters<typeof real.openMtcDb>) =>
			args[0] === undefined ? harness.db : real.openMtcDb(...args)
	};
});
vi.mock('$lib/profile/context', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/profile/context')>();
	return {
		...real,
		// The layout sets the app; a page drawn beside it reads the same one.
		setProfileApp: (app: ProfileApp) => {
			harness.app = app;
			real.setProfileApp(app);
		},
		getProfileApp: () => harness.app
	};
});
vi.mock('$lib/keystore/app-lock-store', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/keystore/app-lock-store')>();
	return {
		...real,
		runPinCheck: ((...args: Parameters<typeof real.runPinCheck>) =>
			harness.check ? harness.check() : real.runPinCheck(...args)) as typeof real.runPinCheck
	};
});
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: false,
		installed: true,
		ios: false,
		persisted: true,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
}));
vi.mock('$lib/ask', async (importOriginal) => {
	const real = await importOriginal<typeof import('$lib/ask')>();
	return {
		...real,
		// The stand-in, or the real store with the answer server replaced: the page's own summary closure, the consent and
		// the summaries setting stay as the page gives them, so the state is the one the page really holds.
		createAskStore: (deps: Parameters<typeof real.createAskStore>[0]) =>
			harness.realAsk
				? real.createAskStore({
						...deps,
						retrieveOnline: async () => ({
							status: 'results',
							corpusVersion: '1.0',
							results: [
								{
									score: 0.9,
									chunk: {
										id: 'a',
										text: 'An official passage.',
										sourceId: 's',
										sourceTitle: 'S',
										url: 'https://x.gov',
										tags: []
									}
								}
							]
						})
					})
				: askStore,
		createRecoveringEmbed: () => ({ embed: async () => [], dispose: () => {} })
	};
});
vi.mock('$lib/ask/embed-worker?worker', () => ({ default: class {} }));
vi.mock('$lib/ask/device-files', () => ({ deviceFilesKept: async () => true }));
// No worker controls the test page, so the real wait would last its full time.
vi.mock('$lib/ask/when-controlled', () => ({ waitForControl: () => Promise.resolve(true) }));

// One distinct string in each encrypted store's plaintext, and one for the typed question.
const CANARY = {
	profile: 'CANARY-PROFILE-rank',
	timeline: 'CANARY-TIMELINE-note',
	calendar: 'CANARY-CALENDAR-event',
	byok: 'CANARY-BYOK-key',
	finder: 'CANARY-FINDER-org',
	pack: 'CANARY-PACK-org',
	ask: 'CANARY-ASK-question'
} as const;
const CANARIES = Object.values(CANARY);
const SUMMARIES_KEY = 'mtc:ask:synthesis-enabled';
const CONSENT_KEY = 'mtc:ask:online-consented';
const TASK = KNOWN_TASK_IDS[0] as string;

const ask = $state<{ state: AskState; mode: 'device' | 'online' }>({
	state: { kind: 'idle' },
	mode: 'online'
});
const card = (over: Partial<ResultCard> = {}): ResultCard => ({
	sourceId: 'va_intent_to_file',
	sourceTitle: 'VA - Intent to File',
	chunkId: 'va_intent_to_file:000000000001',
	section: 'How to submit',
	page: 12,
	excerpt: 'An intent to file lets you notify VA that you plan to file a claim.',
	url: 'https://www.va.gov/',
	score: 0.82,
	...over
});
const askStore = {
	get state() {
		return ask.state;
	},
	get mode() {
		return ask.mode;
	},
	showNudge: false,
	ask: vi.fn(async () => {
		ask.state = { kind: 'results', origin: ask.mode, cards: [card()] };
	}),
	setMode: vi.fn((m: 'device' | 'online') => {
		ask.mode = m;
	}),
	setUp: async () => {},
	dismissSetup: () => {},
	consentOnline: async () => {},
	stayOnDevice: async () => {},
	dismissNudge: () => {},
	// A lock clears the question and the answer on screen, as the real store's does.
	clear: () => {
		ask.state = { kind: 'idle' };
	}
};

const children = createRawSnippet(() => ({ render: () => '<p>page</p>' }));
let db: IDBDatabase | null = null;
let keys: { macKey: CryptoKey; kek: CryptoKey } | null = null;

const need = <T>(v: T | null | undefined): T => {
	if (v === null || v === undefined) throw new Error('test setup: missing');
	return v;
};
const bytes = (text: string) => new TextEncoder().encode(text);
const isoFromToday = (days: number) => {
	const d = new Date();
	d.setDate(d.getDate() + days);
	return localTodayIso(d);
};
const readRaw = (store: StoreName) =>
	withStores(need(db), store, 'readonly', (tx) =>
		reqToPromise<Record<string, unknown> | undefined>(tx.objectStore(store).get(0))
	);

/**
 * A device a person turned a PIN on for: real stores and real saves under the local keys, the real turn-on moves every
 * record onto the PIN's keys, and the public pack is downloaded after it (the turn-on drops the pack). Then the tab
 * forgets its keys, as a reload does.
 */
async function pinDevice(): Promise<void> {
	db = await openTestDb();
	await bootstrapLocalKeystore(db);
	await createProfileStore(db).save({
		setupIntent: 'completed',
		eaos: encodeEaos(parseEaosAtRead(isoFromToday(200))),
		rank: bytes(CANARY.profile)
	});
	const timeline = createTimelineStateStore(db);
	await timeline.load();
	await timeline.setNote(TASK, CANARY.timeline);
	const calendar = createCalendarSyncStore(db);
	await calendar.load();
	await calendar.recordAdd(
		[
			{ taskId: TASK, moment: 'last', title: CANARY.calendar, isoDate: '2099-01-01', alarmDays: [] }
		],
		isoFromToday(0),
		isoFromToday(0)
	);
	const finder = createFinderStore(db);
	await finder.load();
	await finder.save(cleanListing({ n: CANARY.finder }), isoFromToday(0));
	await createByokStore(db).saveApiKey(`sk-ant-${CANARY.byok}-0123456789`);

	const hmac = { name: 'HMAC', hash: 'SHA-256', length: 256 } as const;
	keys = {
		macKey: await crypto.subtle.generateKey(hmac, false, ['sign', 'verify']),
		kek: await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
			'wrapKey',
			'unwrapKey'
		])
	};
	const turnedOn = await rotateToPin(db, {
		...keys,
		salt: crypto.getRandomValues(new Uint8Array(16)),
		kdf: { ...KDF_V1 },
		counterBefore: await readCounter(db)
	});
	setSession(turnedOn.session);
	const pack = createFinderPackStore(db);
	await pack.load();
	await pack.swap({
		index: {
			v: 1,
			pullDate: isoFromToday(0),
			baseline: false,
			baselineDate: isoFromToday(-20),
			files: [{ name: 'pacific', count: 1, bytes: 100 }]
		},
		regions: new Map([
			[
				'pacific',
				{
					v: 1,
					pullDate: isoFromToday(0),
					file: 'pacific',
					listings: [cleanListing({ i: 1001, n: CANARY.pack })]
				}
			]
		])
	});
	dropSession();
	harness.db = Promise.resolve(db);
}

/** The layout's app once start-up has finished and its relock seams are wired. */
async function readyApp(): Promise<ProfileApp> {
	await render(Layout, { children });
	await vi.waitFor(() => {
		expect(harness.app?.status).toBe('ready');
		expect(harness.app?.relockAll).not.toBeNull();
		expect(harness.app?.timeline).not.toBeNull();
		expect(harness.app?.calendar).not.toBeNull();
	});
	return need(harness.app);
}

/** The person enters the PIN: a session is set from the stored row, and the app loads every store. */
async function unlock(app: ProfileApp): Promise<void> {
	const stored = need(await readRaw('keystore')) as unknown as KeystoreRecordPin;
	setSession(await openPinSession(stored, need(keys), await readCounter(need(db))));
	await need(app.unlockStores)();
}

/**
 * Everywhere saved text could reach a person's eyes or a screen reader: every text node, every attribute value and the
 * value of every field. Returns where each canary was found.
 */
function onScreen(): string[] {
	const found: string[] = [];
	const note = (where: string, text: string | null | undefined): void => {
		const canary = text ? CANARIES.find((c) => text.includes(c)) : undefined;
		if (canary) found.push(`${where}: ${canary}`);
	};
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let n = walker.nextNode(); n; n = walker.nextNode()) note('text', n.nodeValue);
	for (const el of document.body.querySelectorAll('*')) {
		for (const name of el.getAttributeNames()) note(`attribute ${name}`, el.getAttribute(name));
		if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
			note('field value', el.value);
		}
	}
	return found;
}

// The PIN card is found by its field: LockedPanel, the local Unlock, shows the same heading and has no field.
const pinField = () => page.getByLabelText('PIN', { exact: true });
const lockButton = () => page.getByRole('button', { name: 'Lock', exact: true });
// The lead card and its label both read this; the first is the label.
const topMatch = () => page.getByText('Top match', { exact: true }).first();
const askField = () => document.querySelector<HTMLInputElement>('.ask-input')!;
const typeQuestion = (text: string): void => {
	askField().value = text;
	askField().dispatchEvent(new Event('input', { bubbles: true }));
};
const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()));
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

beforeEach(async () => {
	ask.state = { kind: 'idle' };
	ask.mode = 'online';
	askStore.ask.mockClear();
	askStore.setMode.mockClear();
	harness.app = null;
	vi.spyOn(navigator.serviceWorker, 'register').mockResolvedValue({} as ServiceWorkerRegistration);
	await pinDevice();
});

afterEach(async () => {
	harness.check = null;
	harness.realAsk = false;
	localStorage.removeItem(SUMMARIES_KEY);
	localStorage.removeItem(CONSENT_KEY);
	dropSession();
	setOnSessionMismatch(null);
	vi.restoreAllMocks();
	if (db) await deleteTestDb(db);
	db = null;
	keys = null;
});

describe('the scan the canary cases rely on', () => {
	// A scan that cannot see one of these places would let the cases below pass on a page that leaks there.
	it('finds a canary in a text node, an attribute value and a field value', () => {
		const host = document.body.appendChild(document.createElement('div'));
		try {
			host.append(
				Object.assign(document.createElement('p'), { textContent: CANARY.profile }),
				Object.assign(document.createElement('span'), { title: CANARY.timeline }),
				Object.assign(document.createElement('input'), { value: CANARY.ask })
			);

			expect(onScreen()).toEqual([
				`text: ${CANARY.profile}`,
				`attribute title: ${CANARY.timeline}`,
				`field value: ${CANARY.ask}`
			]);
		} finally {
			host.remove();
		}
	});
});

describe('a PIN-locked tab after a reload', () => {
	// Each route is drawn on the real locked app with a record in every encrypted store: none of it may reach the screen.
	it.each([
		['Home', HomePage],
		['Timeline', TimelinePage],
		['Settings', SettingsPage]
	])('%s shows the Unlock card and none of the six stores', async (_name, Page) => {
		await readyApp();
		await render(Page);

		await expect.element(pinField()).toBeVisible();
		expect(onScreen()).toEqual([]);
	});
});

describe('a tab that locks while saved text is on screen', () => {
	// What each route can show of a store when it is open: the control that proves the scan sees it before the Lock.
	const OPEN = [
		[
			'Home',
			HomePage,
			async () => {
				typeQuestion(CANARY.ask);
				await expect.poll(onScreen).toEqual([`field value: ${CANARY.ask}`]);
			}
		],
		['Timeline', TimelinePage, () => expect.poll(onScreen).toContain(`text: ${CANARY.timeline}`)],
		['Settings', SettingsPage, () => expect.poll(onScreen).toContain(`text: ${CANARY.calendar}`)]
	] as const;

	it.each(OPEN)('%s: the Lock takes it all off the screen', async (_name, Page, seeIt) => {
		const app = await readyApp();
		await unlock(app);
		await render(Page);
		await seeIt();

		app.relockAll?.();

		await expect.element(pinField()).toBeVisible();
		expect(onScreen()).toEqual([]);
	});

	// The page itself, not the emptied stores, keeps it off: the plaintext is still in memory and only the lock flag is set.
	it.each([
		['Timeline', TimelinePage, CANARY.timeline],
		['Settings', SettingsPage, CANARY.calendar]
	])('%s: the gate hides what the stores still hold', async (_name, Page, held) => {
		const app = await readyApp();
		await unlock(app);
		await render(Page);
		await expect.poll(onScreen).toContain(`text: ${held}`);

		app.pinLocked = true;
		await tick();
		await frame();

		expect(onScreen()).toEqual([]);
		await expect.element(pinField()).toBeVisible();
	});
});

describe('Settings, PIN-locked', () => {
	it('shows the Unlock card, then App lock reading PIN on and the Erase, and nothing behind the keys', async () => {
		const app = await readyApp();
		await render(SettingsPage);

		await expect.element(pinField()).toBeVisible();
		const row = page.getByRole('button', { name: /App lock/ });
		await expect.element(row).toHaveTextContent('App lock PIN on');
		await expect.element(row).toHaveAttribute('aria-expanded', 'false');
		await row.click();
		await expect
			.element(
				page.getByText(
					'The app asks for your PIN when it opens, after 15 minutes idle, and after Lock.'
				)
			)
			.toBeVisible();
		expect(page.getByLabelText('Choose a 4-6 digit PIN').query()).toBeNull();

		// Already locked: no Lock button; and neither the calendar nor the backup, which need the keys.
		expect(lockButton().query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Calendar' }).query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Backup' }).query()).toBeNull();
		expect(page.getByRole('heading', { name: 'Online answers' }).query()).toBeNull();
		expect(app.pinLocked).toBe(true);

		// The way out for a forgotten PIN stays one press away.
		// Pressed in the page itself: the layout's bar, drawn beside this page rather than around it, covers the button.
		const erase = page.getByRole('button', { name: 'Erase all data on this device' });
		await expect.element(erase).toBeVisible();
		(erase.element() as HTMLButtonElement).click();
		await expect
			.element(page.getByRole('heading', { name: 'Erase all data on this device?' }))
			.toBeVisible();
		expect(document.querySelector<HTMLDialogElement>('dialog.wipe-dialog')?.open).toBe(true);
	});

	it('puts the privacy section after the Unlock card', async () => {
		await readyApp();
		await render(SettingsPage);
		await expect.element(pinField()).toBeVisible();

		const privacy = page.getByRole('heading', { name: 'Privacy and security' }).element();
		expect(
			pinField().element().compareDocumentPosition(privacy) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});
});

describe('Home, PIN-locked', () => {
	it('puts the Unlock card where the timeline row would be, and Ask still answers on the device', async () => {
		await readyApp();
		await render(HomePage);

		await expect.element(pinField()).toBeVisible();
		expect(page.getByText('Unlock to see what is due').query()).toBeNull();
		expect(page.getByRole('heading', { name: 'For you', exact: true }).query()).toBeNull();
		expect(page.getByRole('link', { name: 'Set up your timeline' }).query()).toBeNull();

		await expect.element(page.getByRole('button', { name: 'Search' })).toBeEnabled();
		await page.getByRole('button', { name: 'On device' }).click();
		expect(askStore.setMode).toHaveBeenCalledWith('device');
		typeQuestion('how do I file a claim');
		await page.getByRole('button', { name: 'Search' }).click();

		expect(askStore.ask).toHaveBeenCalledOnce();
		await expect.element(topMatch()).toBeVisible();
		await expect.element(page.getByText('An intent to file lets you notify VA')).toBeVisible();
		// The card stays under the answer: it is still the way in.
		await expect.element(pinField()).toBeVisible();
	});
});

describe('Home, PIN-locked, with an online answer on screen', () => {
	const LINE = 'Summaries need your PIN.';
	const summaryUnlock = () =>
		document.querySelector<HTMLButtonElement>('.ask-locked-summary__unlock');
	// An online answer as the store builds it with summaries asked for and none made: the quoted extract, with its note.
	const onlineAnswer = async () => {
		await expect.element(page.getByRole('button', { name: 'Search' })).toBeEnabled();
		const lead = card();
		const answer = chooseAnswer({
			eligibilityIntent: false,
			synthesis: { kind: 'unavailable' },
			extractive: toExtractiveAnswer([lead])
		});
		ask.state = { kind: 'results', origin: 'online', cards: [lead], ...(answer ? { answer } : {}) };
	};
	// Summaries are off until the person turns them on in Settings.
	beforeEach(() => localStorage.setItem(SUMMARIES_KEY, '1'));

	it('with a saved key but summaries off, shows the cards and no line', async () => {
		localStorage.removeItem(SUMMARIES_KEY);
		const app = await readyApp();
		const asked = vi.spyOn(need(app.byok), 'hasApiKey');
		await render(HomePage);
		await onlineAnswer();
		await vi.waitFor(() => expect(asked).toHaveBeenCalled());
		expect(await asked.mock.results[0]?.value).toBe(true);
		await tick();
		await frame();

		await expect.element(topMatch()).toBeVisible();
		expect(page.getByText(LINE).query()).toBeNull();
		expect(summaryUnlock()).toBeNull();
	});

	// The question decides whether a summary is ever made: the store answers an eligibility question with the quoted
	// extract alone, and says so after an unlock. The line must agree with the store, so both read the same question.
	describe('through the real Ask store', () => {
		const GATED = 'how do I file a claim';
		const UNGATED = 'what is the Transition Assistance Program';
		const NO_SUMMARY_NOTE = 'No AI summary is shown for this answer.';

		async function askAndSettle(question: string): Promise<void> {
			harness.realAsk = true;
			localStorage.setItem(CONSENT_KEY, '1');
			const app = await readyApp();
			const asked = vi.spyOn(need(app.byok), 'hasApiKey');
			await render(HomePage);
			await expect.element(page.getByRole('button', { name: 'Search' })).toBeEnabled();
			typeQuestion(question);
			await page.getByRole('button', { name: 'Search' }).click();
			await expect.element(topMatch()).toBeVisible();
			await vi.waitFor(() => expect(asked).toHaveBeenCalled());
			expect(await asked.mock.results[0]?.value).toBe(true);
			await tick();
			await frame();
		}

		it('says the summary needs the PIN on a question that would get one', async () => {
			expect(detectEligibilityIntent(UNGATED).shortCircuit).toBe(false);
			await askAndSettle(UNGATED);

			await expect.element(page.getByText(LINE)).toBeVisible();
			expect(document.body.textContent).not.toContain(NO_SUMMARY_NOTE);
		});

		it('keeps the line off an eligibility question, which never gets a summary', async () => {
			expect(detectEligibilityIntent(GATED).shortCircuit).toBe(true);
			await askAndSettle(GATED);

			expect(page.getByText(LINE).query()).toBeNull();
			expect(summaryUnlock()).toBeNull();
			expect(document.body.textContent).toContain(NO_SUMMARY_NOTE);
		});
	});

	it('with a saved key, points to the Unlock, and the Unlock puts the cursor in the card PIN field', async () => {
		await readyApp();
		await render(HomePage);
		await onlineAnswer();

		await expect.element(page.getByText(LINE)).toBeVisible();
		expect(summaryUnlock()?.textContent?.trim()).toBe('Unlock');
		summaryUnlock()?.click();
		await frame();

		expect(document.activeElement).toBe(pinField().element());
	});

	it('with no saved key, shows the cards and no line', async () => {
		const app = await readyApp();
		await need(app.byok).clearApiKey();
		// The page's own question about a saved key, awaited: an absence checked before it answers proves nothing.
		const asked = vi.spyOn(need(app.byok), 'hasApiKey');
		await render(HomePage);
		await onlineAnswer();
		await vi.waitFor(() => expect(asked).toHaveBeenCalled());
		expect(await asked.mock.results[0]?.value).toBe(false);
		await tick();
		await frame();

		await expect.element(topMatch()).toBeVisible();
		expect(page.getByText(LINE).query()).toBeNull();
		expect(summaryUnlock()).toBeNull();
	});

	it('unlocked, leaves the answer to the shipped path and shows no line', async () => {
		const app = await readyApp();
		await unlock(app);
		await render(HomePage);
		await onlineAnswer();

		await expect.element(topMatch()).toBeVisible();
		await pause(100);
		expect(page.getByText(LINE).query()).toBeNull();
		expect(pinField().query()).toBeNull();
	});

	// The Unlock hands focus to the card's field mid-press, so the held key's repeats land there: the field must not
	// treat them as a new press, or the card would try an empty PIN.
	it('a held Enter on the Unlock does not press the card Unlock', async () => {
		await readyApp();
		await render(HomePage);
		await onlineAnswer();
		await expect.element(page.getByText(LINE)).toBeVisible();

		summaryUnlock()?.focus();
		const enter = {
			key: 'Enter',
			code: 'Enter',
			windowsVirtualKeyCode: 13,
			text: String.fromCharCode(13)
		};
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter });
		for (let i = 0; i < 6; i++) {
			await pause(40);
			await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...enter });
		}
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
		await pause(50);

		expect(document.activeElement).toBe(pinField().element());
		expect(document.querySelector('.pin-unlock [role="alert"]')).toBeNull();
	});
});

describe('Home, where focus goes once an unlock lands', () => {
	// The check itself is the card's own test; here it only sets the session and ends well, and the app loads the stores.
	const arm = () => {
		harness.check = async () => {
			const stored = need(await readRaw('keystore')) as unknown as KeystoreRecordPin;
			setSession(await openPinSession(stored, need(keys), await readCounter(need(db))));
			return { kind: 'good', value: true, wrongTries: 0, unfinished: false };
		};
	};
	const gone = () => expect.poll(() => pinField().query()).toBeNull();

	// A tap on a phone must not open the keyboard by focusing a text field.
	it('after a tap on Unlock, goes to the page heading', async () => {
		arm();
		// A wide page has no bottom bar over the button, so a real pointer press reaches it.
		const { width, height } = { width: window.innerWidth, height: window.innerHeight };
		await page.viewport(1280, 900);
		try {
			await readyApp();
			await render(HomePage);
			await pinField().fill('1234');
			await page.getByRole('button', { name: 'Unlock', exact: true }).click();
			await gone();
			await frame();

			expect(document.activeElement).toBe(document.querySelector('h1.home-hero'));
		} finally {
			await page.viewport(width, height);
		}
	});

	it('after an Enter in the PIN field, goes to the question field', async () => {
		arm();
		await readyApp();
		await render(HomePage);
		await pinField().fill('1234');
		await userEvent.keyboard('{Enter}');
		await gone();
		await frame();

		expect(document.activeElement).toBe(askField());
	});
});

describe('the pages that stay open while PIN-locked', () => {
	it('Resources lists its links', async () => {
		await readyApp();
		await render(ResourcesPage);
		await expect.element(page.getByRole('heading', { level: 1, name: 'Resources' })).toBeVisible();
		expect(page.getByRole('link').elements().length).toBeGreaterThan(3);
	});

	it('Documents lists its documents', async () => {
		await readyApp();
		await render(DocumentsPage);
		await expect.element(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
	});
});
