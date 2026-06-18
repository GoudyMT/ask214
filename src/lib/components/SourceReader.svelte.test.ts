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
		texts: [
			'An intent to file lets you tell VA that you plan to file a claim.',
			'Filing one sets a potential effective date for your benefits.'
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
		expect(container.querySelector('.reader__title')).toBeNull();
	});
});
