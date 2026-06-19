import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import AskView from './AskView.svelte';
import type { AskState } from '$lib/ask/types';
import { ASK_ERROR } from '$lib/ask/errors';
import type { ResultCard } from '$lib/corpus';
import type { Source } from '$lib/ask/sources';

type ViewProps = {
	askState: AskState;
	ready: boolean;
	onAsk: (query: string) => void;
	onSetUp: () => void;
	onDismiss: () => void;
	sources: Map<string, Source>;
};

const noop = () => {};

function props(state: AskState, over: Partial<ViewProps> = {}): ViewProps {
	return {
		askState: state,
		ready: true,
		onAsk: noop,
		onSetUp: noop,
		onDismiss: noop,
		sources: new Map(),
		...over
	};
}

function card(over: Partial<ResultCard> = {}): ResultCard {
	return {
		sourceId: 'va_intent_to_file',
		sourceTitle: 'VA - Intent to File',
		section: 'How to submit',
		page: 12,
		excerpt: 'An intent to file lets you notify VA that you plan to file a claim.',
		url: 'https://www.va.gov/',
		score: 0.82,
		...over
	};
}

describe('AskView', () => {
	it('idle: renders the query input, example chips, and the privacy line', () => {
		const { container } = render(AskView, { props: props({ kind: 'idle' }) });
		expect(container.querySelector('.ask-input')).not.toBeNull();
		expect(container.querySelectorAll('.ask-example').length).toBeGreaterThan(0);
		expect(container.querySelector('.ask-private')).not.toBeNull();
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

	it('results: renders the lead card; extra hits collapse behind a "similar sources" toggle', () => {
		const cards = [
			card({ sourceTitle: 'Lead Source' }),
			card({ sourceTitle: 'Similar A' }),
			card({ sourceTitle: 'Similar B' })
		];
		const { container } = render(AskView, { props: props({ kind: 'results', cards }) });
		expect(container.querySelector('.ask-card--lead')?.textContent).toContain('Lead Source');
		const toggle = container.querySelector('.ask-toggle') as HTMLButtonElement;
		expect(toggle.textContent).toContain('2'); // "Show 2 similar sources"
		expect(container.querySelectorAll('.ask-similar .ask-card').length).toBe(0); // collapsed
		toggle.click();
		flushSync();
		expect(container.querySelectorAll('.ask-similar .ask-card').length).toBe(2); // expanded
	});

	it('results: a single hit shows the lead with no similar toggle', () => {
		const { container } = render(AskView, { props: props({ kind: 'results', cards: [card()] }) });
		expect(container.querySelector('.ask-card--lead')).not.toBeNull();
		expect(container.querySelector('.ask-toggle')).toBeNull();
	});

	it('results: "Read full source" opens the offline reader with that source\'s held text', () => {
		const lead = card({ sourceId: 'va_intent', sourceTitle: 'VA - Intent to File' });
		const sources = new Map<string, Source>([
			[
				'va_intent',
				{
					sourceId: 'va_intent',
					title: 'VA - Intent to File',
					url: 'https://www.va.gov/',
					texts: ['Held passage one.', 'Held passage two.']
				}
			]
		]);
		const { container } = render(AskView, {
			props: props({ kind: 'results', cards: [lead] }, { sources })
		});
		expect(container.querySelector('.reader__title')).toBeNull(); // reader closed initially
		(container.querySelector('.ask-card__read') as HTMLButtonElement).click();
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		expect(container.querySelector('.reader__title')?.textContent).toBe('VA - Intent to File');
		expect(container.querySelectorAll('.reader__passage').length).toBe(2);
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
});
