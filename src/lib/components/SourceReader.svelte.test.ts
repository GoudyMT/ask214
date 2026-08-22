import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import SourceReader from './SourceReader.svelte';
import type { Source } from '$lib/ask/sources';

function source(over: Partial<Source> = {}): Source {
	return {
		sourceId: 'va_intent_to_file',
		title: 'VA - Intent to File',
		url: 'https://www.va.gov/',
		passages: [
			{ id: 's1', text: 'An intent to file lets you tell VA that you plan to file a claim.' },
			{ id: 's2', text: 'Filing one sets a potential effective date for your benefits.' }
		],
		...over
	};
}

describe('SourceReader', () => {
	it('opens as a modal dialog showing the source title and every held passage', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog).not.toBeNull();
		expect(dialog.open).toBe(true); // showModal(), not a non-modal `open` attribute
		expect(container.querySelector('.reader__title')?.textContent).toBe('VA - Intent to File');
		const passages = container.querySelectorAll('.reader__passage');
		expect(passages.length).toBe(2);
		expect(passages[0]?.textContent).toContain('intent to file lets you');
		expect(passages[1]?.textContent).toContain('effective date');
	});

	it('links to the official site safely (new tab, noopener noreferrer)', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => {} }
		});
		flushSync();
		const link = container.querySelector('.reader__link') as HTMLAnchorElement;
		expect(link.getAttribute('href')).toBe('https://www.va.gov/');
		expect(link.getAttribute('target')).toBe('_blank');
		expect(link.getAttribute('rel')).toBe('noopener noreferrer');
	});

	it('the close button fires onClose', () => {
		let closed = 0;
		const { container } = render(SourceReader, {
			props: { source: source(), onClose: () => closed++ }
		});
		flushSync();
		(container.querySelector('.reader__close') as HTMLButtonElement).click();
		flushSync();
		expect(closed).toBe(1);
	});

	it('renders no dialog content and stays closed when there is no source', () => {
		const { container } = render(SourceReader, { props: { source: null, onClose: () => {} } });
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(false);
		// a closed <dialog> must keep the UA display:none - else the empty box paints a bar in page flow
		expect(getComputedStyle(dialog).display).toBe('none');
		expect(container.querySelector('.reader__title')).toBeNull();
	});

	it('opens in a loading state while the source is being fetched (no silent dead button)', () => {
		const { container } = render(SourceReader, {
			props: { source: null, loading: true, onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true); // the reader opens immediately, giving the click feedback
		expect(container.querySelector('.reader__status')?.textContent).toMatch(/loading/i);
		expect(container.querySelector('.reader__passage')).toBeNull(); // no content yet
	});

	it('opens in an error state when the source cannot be loaded', () => {
		const { container } = render(SourceReader, {
			props: { source: null, error: true, onClose: () => {} }
		});
		flushSync();
		const dialog = container.querySelector('dialog.reader') as HTMLDialogElement;
		expect(dialog.open).toBe(true);
		expect(container.querySelector('.reader__status')?.textContent).toMatch(
			/could ?n.?t|try again/i
		);
	});

	it('error: moves focus to the alert message so a screen reader hears the failure', () => {
		const { container } = render(SourceReader, {
			props: { source: null, error: true, onClose: () => {} }
		});
		flushSync();
		const status = container.querySelector('.reader__status') as HTMLElement;
		expect(status?.getAttribute('role')).toBe('alert');
		expect(document.activeElement).toBe(status); // focus lands on the alert, matching the success path
	});

	it('marks the block whose id matches highlightId as the cited passage', () => {
		const { container } = render(SourceReader, {
			props: { source: source(), highlightId: 's2', onClose: () => {} }
		});
		flushSync();
		const cited = container.querySelectorAll('.reader__passage--cited');
		expect(cited.length).toBe(1);
		expect(cited[0]?.textContent).toContain('effective date'); // the s2 passage
		// the "Cited passage" label is a CSS ::before + aria-label, so it is NOT in the copyable text run
		expect(cited[0]?.textContent).not.toContain('Cited passage');
		expect(cited[0]?.getAttribute('role')).toBe('group');
		expect(cited[0]?.getAttribute('aria-label')).toBe('Cited passage');
		expect(cited[0]?.getAttribute('tabindex')).toBe('-1');
	});

	it('highlights nothing when highlightId is null or matches no block (graceful fallback)', () => {
		const nullId = render(SourceReader, {
			props: { source: source(), highlightId: null, onClose: () => {} }
		});
		flushSync();
		expect(nullId.container.querySelectorAll('.reader__passage--cited').length).toBe(0);

		const noMatch = render(SourceReader, {
			props: { source: source(), highlightId: 'does-not-exist', onClose: () => {} }
		});
		flushSync();
		expect(noMatch.container.querySelectorAll('.reader__passage--cited').length).toBe(0);
	});

	it('renders a section heading and a page marker where the metadata changes', () => {
		const src: Source = {
			sourceId: 's',
			title: 'S',
			url: 'https://www.va.gov/',
			passages: [
				{ id: 'a', text: 'first', page: 3, section: 'Eligibility' },
				{ id: 'b', text: 'second', page: 3, section: 'Eligibility' },
				{ id: 'c', text: 'third', page: 4, section: 'How to apply' }
			]
		};
		const { container } = render(SourceReader, {
			props: { source: src, highlightId: null, onClose: () => {} }
		});
		flushSync();
		const headings = container.querySelectorAll('h3.reader__section');
		expect(headings.length).toBe(2); // one per distinct section, not per block
		expect(headings[0]?.textContent).toBe('Eligibility');
		expect(headings[1]?.textContent).toBe('How to apply');
		expect(container.querySelectorAll('.reader__page').length).toBe(2); // page 3, then page 4
	});

	it('scrolls the cited passage into view and focuses it on open', () => {
		const passages = Array.from({ length: 24 }, (_, i) => ({
			id: `p${i}`,
			text: `Passage number ${i} with enough words to give the reader real height to scroll through.`
		}));
		const tall: Source = {
			sourceId: 's',
			title: 'Big Source',
			url: 'https://www.va.gov/',
			passages
		};
		const { container } = render(SourceReader, {
			props: { source: tall, highlightId: 'p20', onClose: () => {} }
		});
		flushSync();
		const body = container.querySelector('.reader__body') as HTMLElement;
		const cited = container.querySelector('.reader__passage--cited') as HTMLElement;
		expect(body.scrollTop).toBeGreaterThan(0); // scrolled down to the cited block, not left at the top
		expect(document.activeElement).toBe(cited); // focus landed on the cited region
	});
});
