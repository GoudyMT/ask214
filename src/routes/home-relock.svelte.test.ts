import { render } from 'vitest-browser-svelte';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { page } from 'vitest/browser';
import { createJoinRelock, relockEachSync, type Relockable } from '#lib/profile/app-init.js';
import type { RelockReason } from '#lib/profile/lifecycle.js';
import type { RetrieveResult } from '#lib/ask/online/outcome.js';
import HomePage from './+page.svelte';

// Home runs the real Ask store. Only what leaves the page is replaced: the answer server, the summary call, the
// embed worker and the cache read. Each answer is built from the question asked, so what is on screen names it.
const online = vi.hoisted(() => ({
	retrieve: null as unknown as (query: string) => Promise<unknown>
}));
vi.mock('#lib/ask/online/retrieve-online.js', () => ({
	retrieveOnline: (query: string) => online.retrieve(query)
}));
vi.mock('#lib/ask/synthesis/synthesize.js', () => ({
	synthesize: async (query: string) => ({
		kind: 'answer',
		answer: {
			text: `Summary about ${query} [a].`,
			citations: [{ id: 'a', url: 'https://x.gov', title: 'S' }],
			inert: [],
			disclaimer: 'd'
		}
	})
}));
vi.mock('#lib/ask/index.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/ask/index.js')>()),
	createRecoveringEmbed: () => ({ embed: async () => [], dispose: () => {} })
}));
vi.mock('#lib/ask/embed-worker?worker', () => ({ default: class {} }));
vi.mock('#lib/ask/device-files.js', () => ({ deviceFilesKept: async () => true }));
vi.mock('#lib/install/context.js', () => ({
	getInstallApp: () => ({ canPrompt: false, installed: true, ios: false, persisted: false }),
	setInstallApp: () => {}
}));

// The profile app the page reads. Its relock list is the real one: a relock walks it as the layout's does.
const relockables: Relockable[] = [];
const app = $state<{
	status: string;
	store: null;
	timeline: null;
	byok: { readApiKey: () => Promise<string> };
	joinRelock: ((r: Relockable) => () => void) | null;
	publish: null;
	reloadOnUnlock: boolean;
	replacedNotice: boolean;
}>({
	status: 'ready',
	store: null,
	timeline: null,
	byok: { readApiKey: async () => 'key' },
	joinRelock: null,
	publish: null,
	reloadOnUnlock: false,
	replacedNotice: false
});
vi.mock('#lib/profile/context.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/profile/context.js')>()),
	getProfileApp: () => app
}));

const PREFS = ['mtc:ask:online-consented', 'mtc:ask:synthesis-enabled'];
const REASONS: RelockReason[] = ['user', 'idle', 'peer', 'hygiene'];

function found(): RetrieveResult {
	return {
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
	};
}

// Every text node on the page, read as the person would read it (the field's value is not one, so it is read apart).
function pageText(): string {
	const texts: string[] = [];
	const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode())
		texts.push(node.nodeValue ?? '');
	return texts.join(' ').toLowerCase();
}
const field = () => document.querySelector<HTMLInputElement>('.ask-input')!;

async function ask(question: string): Promise<void> {
	await expect.element(page.getByRole('button', { name: 'Search' })).toBeEnabled();
	field().value = question;
	field().dispatchEvent(new Event('input', { bubbles: true }));
	await page.getByRole('button', { name: 'Search' }).click();
}

async function openHome() {
	const view = await render(HomePage);
	// Start-up resolves after the page is up: the list is offered only then.
	app.joinRelock = createJoinRelock(relockables);
	return view;
}

beforeEach(() => {
	relockables.length = 0;
	app.joinRelock = null;
	for (const key of PREFS) localStorage.setItem(key, '1');
	online.retrieve = async () => found();
});
afterEach(() => {
	for (const key of PREFS) localStorage.removeItem(key);
});

describe('Home, when the app locks', () => {
	// A person picks up the phone after the lock: the last question and its answer must be gone, whatever locked it.
	it.each(REASONS)(
		'clears the question, the answer and the summary on a %s relock',
		async (reason) => {
			await openHome();
			await ask('tell me about quokkas');
			await expect.poll(() => pageText()).toContain('summary about tell me about quokkas');
			expect(field().value).toBe('tell me about quokkas');

			relockEachSync(relockables, reason, reason === 'peer' ? { peerReason: 'user' } : undefined);

			await expect.poll(() => field().value).toBe('');
			expect(pageText()).not.toContain('quokkas');
			expect(pageText()).not.toContain('official passage');
		}
	);

	// The answer was on its way when the lock came; the person then asks something else. The first answer arrives
	// first and must not take the place of the wait for the second.
	it('shows nothing of an answer that was in flight at the lock, even when a new question was asked since', async () => {
		const settle = new Map<string, (r: RetrieveResult) => void>();
		online.retrieve = (query) => new Promise((resolve) => settle.set(query, resolve));
		await openHome();

		await ask('tell me about quokkas');
		await expect.poll(() => settle.has('tell me about quokkas')).toBe(true);
		relockEachSync(relockables, 'user');
		await expect.poll(() => field().value).toBe('');

		await ask('tell me about wombats');
		await expect.poll(() => settle.has('tell me about wombats')).toBe(true);
		settle.get('tell me about quokkas')!(found());
		await new Promise((done) => setTimeout(done, 100));
		expect(pageText()).not.toContain('quokkas');
		expect(pageText()).not.toContain('official passage');

		settle.get('tell me about wombats')!(found());
		await expect.poll(() => pageText()).toContain('summary about tell me about wombats');
	});

	// Leaving Home must take the page out of the list, or every later lock would call into a page that is gone.
	it('leaves the relock list when Home goes away', async () => {
		const { unmount } = await openHome();
		await expect.poll(() => relockables.length).toBe(1);
		await unmount();
		expect(relockables).toHaveLength(0);
	});
});
