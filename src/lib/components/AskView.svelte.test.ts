import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import AskView from './AskView.svelte';
import type { AskState } from '$lib/ask/types';
import { ASK_ERROR } from '$lib/ask/errors';
import type { ResultCard } from '$lib/corpus';
import type { Source } from '$lib/ask/sources';
import type { AnswerView } from '$lib/ask/answer/answer-view';
import { OFFICIAL_FALLBACK } from '$lib/ask/crisis/contacts';

type ViewProps = {
	askState: AskState;
	ready: boolean;
	onAsk: (query: string) => void;
	onSetUp: () => void;
	onDismiss: () => void;
	loadSource: (sourceId: string) => Promise<Source | null>;
	onlineCapable?: boolean;
	mode?: 'device' | 'online';
	onSetMode?: (m: 'device' | 'online') => void;
	onConsentOnline?: () => void;
	showNudge?: boolean;
	onDismissNudge?: () => void;
	onOfferDevice?: (query: string) => void;
	onRetryOnline?: (query: string) => void;
	onStayDevice?: () => void;
};

const noop = () => {};

function props(state: AskState, over: Partial<ViewProps> = {}): ViewProps {
	return {
		askState: state,
		ready: true,
		onAsk: noop,
		onSetUp: noop,
		onDismiss: noop,
		loadSource: async () => null,
		...over
	};
}

// Real chunk ids are UNIQUE - `toResultCards` copies `chunk.id`, which the corpus guarantees distinct.
// A constant here gave every card in a multi-card test the same id, so `c.chunkId !== quoted` was false
// for all of them and the "which card did the answer come from" comparison - the exact thing this field
// was added to enable - could never discriminate. Tests that need to pair an answer to a card read the id
// off the card rather than hardcoding it.
let cardSeq = 0;

function card(over: Partial<ResultCard> = {}): ResultCard {
	cardSeq++;
	return {
		sourceId: 'va_intent_to_file',
		sourceTitle: 'VA - Intent to File',
		chunkId: `va_intent_to_file:${String(cardSeq).padStart(12, '0')}`,
		section: 'How to submit',
		page: 12,
		excerpt: 'An intent to file lets you notify VA that you plan to file a claim.',
		url: 'https://www.va.gov/',
		score: 0.82,
		...over
	};
}

describe('AskView', () => {
	it('idle: renders the query input, the question feed, and the privacy line', () => {
		const { container } = render(AskView, { props: props({ kind: 'idle' }) });
		expect(container.querySelector('.ask-input')).not.toBeNull();
		expect(container.querySelectorAll('.q-feed__pill').length).toBeGreaterThan(0);
		expect(container.querySelector('.ask-private')).not.toBeNull();
	});

	it('the result region announces state changes to assistive tech (aria-live, WCAG 4.1.3)', () => {
		const { container } = render(AskView, { props: props({ kind: 'idle' }) });
		expect(container.querySelector('.ask-result')?.getAttribute('aria-live')).toBe('polite');
	});

	it('crisis: renders the crisis-line card, not a normal result state', () => {
		const { container } = render(AskView, { props: props({ kind: 'crisis' }) });
		expect(container.querySelector('.crisis')).not.toBeNull();
		expect(container.querySelector('a[href="tel:988"]')).not.toBeNull();
		expect(container.querySelector('.ask-msg')).toBeNull();
		// The crisis alert must not be nested inside a polite live region (WCAG live-region nesting).
		expect(container.querySelector('.ask-result')?.getAttribute('aria-live')).not.toBe('polite');
	});

	it('idle: clicking a feed pill fills the input and asks that question', () => {
		let asked: string | null = null;
		const { container } = render(AskView, {
			props: props({ kind: 'idle' }, { onAsk: (q: string) => (asked = q) })
		});
		const pill = container.querySelector('.q-feed__pill') as HTMLButtonElement;
		const text = pill.textContent?.trim() ?? '';
		pill.click();
		flushSync();
		expect(asked).toBe(text); // ran the query
		expect((container.querySelector('.ask-input') as HTMLInputElement).value).toBe(text); // filled the bar
	});

	it('submitting the query calls onAsk with the typed text', () => {
		let asked: string | null = null;
		const { container } = render(AskView, {
			props: props({ kind: 'idle' }, { onAsk: (q: string) => (asked = q) })
		});
		const input = container.querySelector('.ask-input') as HTMLInputElement;
		input.value = 'how do I file a claim';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('.ask-search') as HTMLButtonElement).click();
		flushSync();
		expect(asked).toBe('how do I file a claim');
	});

	it('not ready: the input stays usable but Search is gated until the corpus loads', () => {
		const { container } = render(AskView, { props: props({ kind: 'idle' }, { ready: false }) });
		const input = container.querySelector('.ask-input') as HTMLInputElement;
		const search = container.querySelector('.ask-search') as HTMLButtonElement;
		// Usable at once so the first interaction (focus/type) can kick off the deferred corpus load.
		expect(input.disabled).toBe(false);
		// Submission waits for the corpus - a disabled default button also blocks Enter-submit.
		expect(search.disabled).toBe(true);
	});

	it('the Search button keeps the accessible name "Search" (icon-only on mobile stays labelled)', () => {
		const { container } = render(AskView, { props: props({ kind: 'idle' }) });
		const search = container.querySelector('.ask-search') as HTMLButtonElement;
		// The visible label provides the accessible name; the magnifier svg is hidden from AT, so the
		// name stays "Search" even when the label is visually clipped at narrow widths.
		expect(search.querySelector('.ask-search__label')?.textContent?.trim()).toBe('Search');
		expect(search.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('needsSetup: shows the consent card with the preserved query; buttons fire onSetUp / onDismiss', () => {
		let setUp = 0;
		let dismissed = 0;
		const { container } = render(AskView, {
			props: props(
				{ kind: 'needsSetup', pendingQuery: 'am I eligible for SkillBridge?' },
				{ onSetUp: () => setUp++, onDismiss: () => dismissed++ }
			)
		});
		expect(container.querySelector('.ask-setup')).not.toBeNull();
		expect(container.querySelector('.ask-setup')?.textContent).toContain(
			'am I eligible for SkillBridge?'
		);
		(container.querySelector('.ask-setup__go') as HTMLButtonElement).click();
		flushSync();
		expect(setUp).toBe(1);
		(container.querySelector('.ask-setup__skip') as HTMLButtonElement).click();
		flushSync();
		expect(dismissed).toBe(1);
	});

	it('modelLoading / embedding / empty / offline / error render their messages', () => {
		expect(
			render(AskView, { props: props({ kind: 'modelLoading' }) }).container.textContent
		).toContain('Setting up Ask');
		expect(
			render(AskView, { props: props({ kind: 'embedding' }) }).container.textContent
		).toContain('Finding relevant sources');
		expect(render(AskView, { props: props({ kind: 'empty' }) }).container.textContent).toContain(
			'No close match'
		);
		expect(render(AskView, { props: props({ kind: 'offline' }) }).container.textContent).toContain(
			'offline'
		);
		expect(
			render(AskView, {
				props: props({ kind: 'error', code: ASK_ERROR.EMBED })
			}).container.textContent?.toLowerCase()
		).toContain("couldn't run");
	});

	it('empty: keeps the rephrase hint, hedges coverage, and gives a way out of the app', () => {
		const { container } = render(AskView, { props: props({ kind: 'empty' }) });
		const text = container.textContent ?? '';
		expect(text).toContain('No close match');
		expect(text).toMatch(/rephras/i);
		// This state means nothing scored above the cutoff, which is NOT evidence the documents lack the
		// answer - a differently-worded question often reaches it. So the coverage claim stays hedged, and
		// the state must never assert what `notCovered` asserts.
		expect(text).toContain('may not cover it');
		// The number comes from the one verified copy, never a literal: it had already drifted into four
		// places once, and a benefits hotline that is wrong in one of them is the worst failure this
		// audience can be handed.
		expect(text).toContain(OFFICIAL_FALLBACK.phone);
		const link = container.querySelector('a[href="https://www.va.gov/"]');
		expect(link).not.toBeNull();
		// Reverse-tabnabbing: every outbound link in this app carries it.
		expect(link?.getAttribute('rel')).toBe('external noopener');
	});

	it('results: renders the lead card; extra hits collapse behind a "similar sources" toggle', () => {
		const cards = [
			card({ sourceTitle: 'Lead Source' }),
			card({ sourceTitle: 'Similar A' }),
			card({ sourceTitle: 'Similar B' })
		];
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards })
		});
		expect(container.querySelector('.ask-card--lead')?.textContent).toContain('Lead Source');
		const toggle = container.querySelector('.ask-toggle') as HTMLButtonElement;
		expect(toggle.textContent).toContain('2'); // "Show 2 similar sources"
		expect(container.querySelectorAll('.ask-similar .ask-card').length).toBe(0); // collapsed
		toggle.click();
		flushSync();
		expect(container.querySelectorAll('.ask-similar .ask-card').length).toBe(2); // expanded
	});

	it('results: a single hit shows the lead with no similar toggle', () => {
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [card()] })
		});
		expect(container.querySelector('.ask-card--lead')).not.toBeNull();
		expect(container.querySelector('.ask-toggle')).toBeNull();
	});

	const heldSource = (): Source => ({
		sourceId: 'va_intent',
		title: 'VA - Intent to File',
		url: 'https://www.va.gov/',
		passages: [
			{ id: 'h1', text: 'Held passage one.' },
			{ id: 'h2', text: 'Held passage two.' }
		]
	});

	it('results: "Read full source" loads the source on demand and opens the offline reader', async () => {
		const lead = card({ sourceId: 'va_intent', sourceTitle: 'VA - Intent to File' });
		const loadSource = vi.fn(async () => heldSource());
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [lead] }, { loadSource })
		});
		expect(container.querySelector('.reader__title')).toBeNull(); // reader closed initially
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(container.querySelector('.reader__title')?.textContent).toBe('VA - Intent to File');
		});
		expect(loadSource).toHaveBeenCalledWith('va_intent');
		expect(container.querySelectorAll('.reader__passage').length).toBe(2);
	});

	it('results: "Read more" opens the reader highlighting the passage the card cited', async () => {
		const lead = card({ sourceId: 'va_intent', chunkId: 'h2' });
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'device', cards: [lead] },
				{ loadSource: async () => heldSource() }
			)
		});
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(container.querySelector('.reader__passage--cited')?.textContent).toContain(
				'Held passage two.'
			);
		});
		const cited = container.querySelector('.reader__passage--cited');
		expect(document.activeElement).toBe(cited); // focus moved to the cited block once content loaded
	});

	it('results: "Read more" opens the reader in a loading state immediately (no silent dead button)', () => {
		const lead = card({ sourceId: 'va_intent' });
		// A pending load: the reader must still open right away and show loading, not do nothing.
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'device', cards: [lead] },
				{ loadSource: () => new Promise(() => {}) }
			)
		});
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		flushSync();
		expect((container.querySelector('dialog.reader') as HTMLDialogElement).open).toBe(true);
		expect(container.querySelector('.reader__status')?.textContent).toMatch(/loading/i);
	});

	it('results: closing the reader mid-load does not reopen it when the slow load resolves', async () => {
		const lead = card({ sourceId: 'va_intent' });
		let resolveLoad!: (s: Source | null) => void;
		const loadSource = () => new Promise<Source | null>((r) => (resolveLoad = r));
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [lead] }, { loadSource })
		});
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true); // opened at once in the loading state
		(container.querySelector('.reader__close') as HTMLButtonElement).click();
		flushSync();
		expect(dialog.open).toBe(false); // dismissed while the load is still pending
		resolveLoad(heldSource()); // the slow first-corpus load finally resolves
		for (let i = 0; i < 6; i++) {
			await Promise.resolve(); // drain the awaited continuation microtasks
			flushSync(); // and run any scheduled effects
		}
		// The superseded write must be dropped: a dismissed reader must not reopen (nor leak content/focus).
		expect({
			open: dialog.open,
			hasPassage: !!container.querySelector('.reader__passage'),
			title: container.querySelector('.reader__title')?.textContent?.trim() ?? null
		}).toEqual({ open: false, hasPassage: false, title: null });
	});

	it('results: a failed source load shows the reader error state, not a silent no-op', async () => {
		const lead = card({ sourceId: 'va_intent' });
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'device', cards: [lead] },
				{
					loadSource: async () => {
						throw new Error('corpus fetch failed');
					}
				}
			)
		});
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() => {
			expect(container.querySelector('.reader__status')?.textContent).toMatch(
				/could ?n.?t|try again/i
			);
		});
	});

	it('reminder: appears after [Not now] returns to idle, and the x dismisses it for the session', async () => {
		sessionStorage.removeItem('mtc:ask:reminder-dismissed'); // start not-yet-dismissed
		const { container, rerender } = render(AskView, {
			props: props({ kind: 'needsSetup', pendingQuery: 'q' })
		});
		// [Not now] sets the internal "setup dismissed" flag; the reminder still hides while in needsSetup.
		(container.querySelector('.ask-setup__skip') as HTMLButtonElement).click();
		flushSync();
		expect(container.querySelector('.ask-reminder')).toBeNull();
		// The parent then moves the view to idle; rerender updates the SAME instance, keeping setupDismissed.
		await rerender(props({ kind: 'idle' }));
		flushSync();
		expect(container.querySelector('.ask-reminder')).not.toBeNull(); // the nudge now shows
		(container.querySelector('.ask-reminder__x') as HTMLButtonElement).click();
		flushSync();
		expect(container.querySelector('.ask-reminder')).toBeNull(); // dismissed
		expect(sessionStorage.getItem('mtc:ask:reminder-dismissed')).toBe('1'); // persisted for the session
	});

	it('reminder: stays hidden when already dismissed this session', async () => {
		sessionStorage.setItem('mtc:ask:reminder-dismissed', '1'); // dismissed in a prior view
		const { container, rerender } = render(AskView, {
			props: props({ kind: 'needsSetup', pendingQuery: 'q' })
		});
		(container.querySelector('.ask-setup__skip') as HTMLButtonElement).click();
		flushSync();
		await rerender(props({ kind: 'idle' }));
		flushSync();
		expect(container.querySelector('.ask-reminder')).toBeNull(); // reminderDismissed read from sessionStorage
		sessionStorage.removeItem('mtc:ask:reminder-dismissed'); // cleanup
	});

	// --- online affordances (additive; onlineCapable defaults false, so the device tests above are untouched) ---

	it('online-capable: shows the mode switch and the online privacy copy in online mode', () => {
		const { container } = render(AskView, {
			props: props({ kind: 'idle' }, { onlineCapable: true, mode: 'online' })
		});
		expect(container.querySelector('.ask-mode')).not.toBeNull();
		expect(container.querySelector('.ask-private')?.textContent).toContain(
			'only your question is sent'
		);
	});

	it('device mode keeps the on-device privacy copy', () => {
		const { container } = render(AskView, {
			props: props({ kind: 'idle' }, { onlineCapable: true, mode: 'device' })
		});
		expect(container.querySelector('.ask-private')?.textContent).toContain('on your device');
	});

	it('the privacy copy follows the answer origin, not the live mode toggle', async () => {
		// An online answer is on screen; the user then flips the toggle (or the nudge) to "On device". The
		// displayed answer still egressed, so the privacy line and the reader must NOT relabel it as
		// on-device - the copy keys off the result's snapshot origin, never the current mode.
		const lead = card({ sourceId: 'va_intent' });
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'online', cards: [lead] },
				{ onlineCapable: true, mode: 'device', loadSource: async () => heldSource() }
			)
		});
		const priv = container.querySelector('.ask-private')?.textContent ?? '';
		expect(priv).toContain('only your question is sent'); // online-only phrasing
		expect(priv).not.toContain('nothing you type is sent'); // the device-only phrasing must be absent
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(container.querySelector('.reader__title')).not.toBeNull());
		const readerText = container.querySelector('dialog.reader')?.textContent ?? '';
		expect(readerText).toMatch(/passage this answer found/i); // the neutral online reader copy
		expect(readerText).not.toMatch(/no connection needed/i); // never the on-device offline assurance
	});

	// An online answer carries its passage in the search result, so the reader opens on it at once. The answer
	// library is several megabytes and exists for answering offline; reading an online answer's source never
	// fetches it.
	// Opened from the second card, so the passage shown is found by the card's own id, not by position.
	it("opens an online answer's source from the answer itself, without the answer library", async () => {
		const loadSource = vi.fn(async () => heldSource());
		const lead = card();
		const other = card({
			sourceId: 'va_decision_reviews',
			sourceTitle: 'VA - Decision Reviews',
			excerpt: 'A supplemental claim adds new and relevant evidence to a decided claim.'
		});
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'online', cards: [lead, other] },
				{ onlineCapable: true, mode: 'online', loadSource }
			)
		});

		(container.querySelector('.ask-toggle') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(container.querySelector('.ask-similar')).not.toBeNull());
		(container.querySelector('.ask-similar .ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(container.querySelector('.reader__passage--cited')?.textContent?.trim()).toBe(
				other.excerpt
			)
		);
		expect(container.querySelector('.reader__title')?.textContent).toBe('VA - Decision Reviews');
		expect(loadSource).not.toHaveBeenCalled();
	});

	// The answer block names its source by id; the card it came from carries the passage.
	it("opens an online answer's source from the answer block too, without the answer library", async () => {
		const loadSource = vi.fn(async () => heldSource());
		const lead = card();
		const answer: AnswerView = {
			kind: 'extractive',
			answer: {
				text: 'An intent to file lets you notify VA that you plan to file a claim.',
				passage: lead.excerpt,
				sourceId: lead.sourceId,
				sourceTitle: lead.sourceTitle,
				url: lead.url,
				chunkId: lead.chunkId
			}
		};
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'online', cards: [lead], answer },
				{ onlineCapable: true, mode: 'online', loadSource }
			)
		});

		(container.querySelector('.ask-answer__more') as HTMLButtonElement).click();
		await vi.waitFor(() =>
			expect(container.querySelector('.reader__passage--cited')?.textContent?.trim()).toBe(
				lead.excerpt
			)
		);
		expect(loadSource).not.toHaveBeenCalled();
	});

	it('still reads an on-device answer from the answer library', async () => {
		const loadSource = vi.fn(async () => heldSource());
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [card()] }, { loadSource })
		});

		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		await vi.waitFor(() => expect(loadSource).toHaveBeenCalledWith('va_intent_to_file'));
	});

	it('a device answer keeps the on-device copy even after the mode flips to online', () => {
		// The mirror: a genuinely on-device answer keeps its true "nothing sent" assurance, not the neutral
		// online wording, when the toggle is later moved to online.
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'device', cards: [card()] },
				{ onlineCapable: true, mode: 'online' }
			)
		});
		const priv = container.querySelector('.ask-private')?.textContent ?? '';
		expect(priv).toContain('nothing you type is sent'); // device-only phrasing
		expect(priv).not.toContain('only your question is sent'); // the online-only phrasing must be absent
	});

	it('freezes the mode toggle and the nudge button while a query is in flight', () => {
		const { container } = render(AskView, {
			props: props({ kind: 'embedding' }, { onlineCapable: true, mode: 'online', showNudge: true })
		});
		const modeButtons = container.querySelectorAll('.ask-mode__opt');
		expect(modeButtons.length).toBe(2);
		modeButtons.forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
		expect((container.querySelector('.ask-reminder__set') as HTMLButtonElement).disabled).toBe(
			true
		);
	});

	it('needsReconsent: quotes the held query; buttons fire onConsentOnline / onStayDevice', () => {
		let consented = 0;
		let stayed = 0;
		const { container } = render(AskView, {
			props: props(
				{ kind: 'needsReconsent', pendingQuery: 'how do I file a claim' },
				{
					onlineCapable: true,
					onConsentOnline: () => consented++,
					onStayDevice: () => stayed++
				}
			)
		});
		// the preserved question is quoted back in the consent card
		expect(container.querySelector('.ask-msg--accent')?.textContent).toContain(
			'how do I file a claim'
		);
		// the consent gate carries a heading (parity with the device-setup gate, for SR heading-nav)
		expect(container.querySelector('h2')?.textContent).toContain(
			'Send your question to answer online'
		);
		(container.querySelector('.ask-setup__go') as HTMLButtonElement).click();
		flushSync();
		expect(consented).toBe(1);
		(container.querySelector('.ask-setup__skip') as HTMLButtonElement).click();
		flushSync();
		expect(stayed).toBe(1);
	});

	it('results: renders the answer above the cards when present', () => {
		const answer: AnswerView = {
			kind: 'synthesized',
			answer: {
				text: 'Do X [a].',
				citations: [{ id: 'a', url: 'https://x.gov', title: 'S' }],
				inert: [],
				disclaimer: 'd'
			}
		};
		const { container } = render(AskView, {
			props: props(
				{ kind: 'results', origin: 'online', cards: [card()], answer },
				{ onlineCapable: true, mode: 'online' }
			)
		});
		expect(container.querySelector('.ask-answer')).not.toBeNull();
		expect(container.querySelector('.ask-card--lead')).not.toBeNull(); // cards still render below
	});

	// The answer block owns the text at both tiers, so the lead card stops repeating it. The card is not
	// demoted - it keeps its position, its badge, its citation and both actions.
	it('results: the card the answer came from yields its excerpt', () => {
		const lead = card();
		const answer: AnswerView = {
			kind: 'extractive',
			answer: {
				text: 'You have one year to submit the completed claim.',
				passage: 'You have one year to submit the completed claim. It sets your effective date.',
				sourceId: 'va_intent_to_file',
				sourceTitle: 'VA - Intent to File',
				url: 'https://www.va.gov/',
				chunkId: lead.chunkId
			}
		};
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [lead], answer })
		});
		expect(container.querySelector('.ask-card--lead .ask-card__excerpt')).toBeNull();
		expect(container.querySelector('.ask-card__top-match')).not.toBeNull();
		expect(container.querySelector('.ask-card__link')).not.toBeNull();
	});

	// The counterpart: when the answer came from a card OTHER than the lead, the lead must KEEP its excerpt.
	// The answer is now always taken from the lead card, so this branch is DEFENSIVE rather than routine -
	// it is what stops a future change to which card answers from silently blanking a compact card, and it
	// is exactly the defect that shipped once when the yield rule was widened beyond the lead.
	it('results: a card the answer did NOT come from keeps its excerpt', () => {
		const lead = card();
		const other = card();
		const answer: AnswerView = {
			kind: 'extractive',
			answer: {
				text: 'You have one year to submit the completed claim.',
				passage: 'You have one year to submit the completed claim. It sets your effective date.',
				sourceId: 'va_intent_to_file',
				sourceTitle: 'VA - Intent to File',
				url: 'https://www.va.gov/',
				chunkId: other.chunkId
			}
		};
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [lead, other], answer })
		});
		expect(container.querySelector('.ask-card--lead .ask-card__excerpt')).not.toBeNull();
	});

	// The yield exists to stop the same sentences printing twice, which is real for a 120-word lead card
	// sitting directly under the answer. A compact card caps at 24 words and lives behind a toggle the
	// reader deliberately opened, so there is no accidental double-read to prevent - and suppressing it
	// leaves a card with a title, two links and NO text. That is how the card which actually produced the
	// answer ends up being the one that looks broken, on roughly 4 queries in 10.
	it('results: a compact card keeps its excerpt even when the answer came from it', () => {
		const lead = card();
		const other = card();
		const answer: AnswerView = {
			kind: 'extractive',
			answer: {
				text: 'You have one year to submit the completed claim.',
				passage: 'You have one year to submit the completed claim. It sets your effective date.',
				sourceId: 'va_intent_to_file',
				sourceTitle: 'VA - Intent to File',
				url: 'https://www.va.gov/',
				chunkId: other.chunkId
			}
		};
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [lead, other], answer })
		});
		(container.querySelector('.ask-toggle') as HTMLButtonElement).click();
		flushSync();
		expect(container.querySelector('.ask-similar .ask-card__excerpt')).not.toBeNull();
	});

	// A synthesized answer paraphrases, so there is no duplication to remove and the card is untouched.
	// This is the shipped BYO-key surface, which must not change.
	it('results: the lead card keeps its excerpt under a synthesized answer', () => {
		const answer: AnswerView = {
			kind: 'synthesized',
			answer: {
				text: 'Notify VA first, then you have a year.',
				citations: [],
				inert: [],
				disclaimer: 'd'
			}
		};
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'online', cards: [card()], answer })
		});
		expect(container.querySelector('.ask-card--lead .ask-card__excerpt')).not.toBeNull();
	});

	it('results: the lead card keeps its excerpt when there is no answer at all', () => {
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [card()] })
		});
		expect(container.querySelector('.ask-card--lead .ask-card__excerpt')).not.toBeNull();
	});

	// The default and offline user has no key, so the extractive answer is the only one they ever see -
	// it must render in the same slot, above the same unchanged cards.
	it('results: renders the extractive answer in the same slot on the device path', () => {
		const answer: AnswerView = {
			kind: 'extractive',
			answer: {
				text: 'You have one year to submit the completed claim.',
				passage: 'You have one year to submit the completed claim. It sets your effective date.',
				sourceId: 'va_intent_to_file',
				sourceTitle: 'VA - Intent to File',
				url: 'https://www.va.gov/'
			}
		};
		const { container } = render(AskView, {
			props: props({ kind: 'results', origin: 'device', cards: [card()], answer })
		});
		expect(container.querySelector('.ask-answer')).not.toBeNull();
		expect(container.textContent).toContain('one year to submit');
		expect(container.querySelector('.ask-card--lead')).not.toBeNull();
	});

	it('degraded offer_device: the button re-runs the kept query on the device path', () => {
		let offered: string | null = null;
		const { container } = render(AskView, {
			props: props(
				{ kind: 'degraded', rung: 'offer_device', query: 'gi bill' },
				{ onlineCapable: true, onOfferDevice: (q) => (offered = q) }
			)
		});
		(container.querySelector('.ask-msg--warn button') as HTMLButtonElement).click();
		flushSync();
		expect(offered).toBe('gi bill');
	});

	it('nudge: shows when showNudge and dismisses / switches to device', () => {
		let dismissed = 0;
		const { container } = render(AskView, {
			props: props(
				{ kind: 'idle' },
				{ onlineCapable: true, showNudge: true, onDismissNudge: () => dismissed++ }
			)
		});
		expect(container.querySelector('.ask-reminder')).not.toBeNull();
		(container.querySelector('.ask-reminder__x') as HTMLButtonElement).click();
		flushSync();
		expect(dismissed).toBe(1);
	});
});
