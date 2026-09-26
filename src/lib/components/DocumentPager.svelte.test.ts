import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import DocumentPager from './DocumentPager.svelte';

const button = (container: Element, label: string) =>
	[...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const field = (container: Element) => container.querySelector('input') as HTMLInputElement;
const text = (container: Element) => container.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Type into the page number and commit it, as leaving the field or pressing Enter does. */
function enter(container: Element, value: string, how: 'change' | 'Enter' = 'change') {
	const input = field(container);
	input.value = value;
	if (how === 'Enter')
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	else input.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('DocumentPager', () => {
	it('shows the page on screen as a number the user can change, and the page count', () => {
		const { container } = render(DocumentPager, {
			props: { page: 3, pageCount: 12, onpage: vi.fn() }
		});
		expect(field(container).value).toBe('3');
		expect(field(container).getAttribute('aria-label')).toBe('Page number');
		expect(text(container)).toContain('Page');
		expect(text(container)).toContain('of 12');
	});

	// The scroll does what Previous and Next did; the keyboard scrolls the focused page.
	it('has no Previous or Next, only the page number', () => {
		const { container } = render(DocumentPager, {
			props: { page: 3, pageCount: 12, onpage: vi.fn() }
		});
		expect(container.querySelectorAll('button')).toHaveLength(0);
		expect(button(container, 'Previous')).toBeUndefined();
		expect(button(container, 'Next')).toBeUndefined();
	});

	it('follows the page in view', async () => {
		const { container, rerender } = render(DocumentPager, {
			props: { page: 3, pageCount: 12, onpage: vi.fn() }
		});
		await rerender({ page: 7 });
		expect(field(container).value).toBe('7');
	});

	// Scrolling under a half-typed number must not overwrite it; once the reader leaves the field, it
	// shows the page in view again.
	it('holds the number still while the reader is typing in it', async () => {
		const { container, rerender } = render(DocumentPager, {
			props: { page: 3, pageCount: 12, onpage: vi.fn() }
		});
		field(container).focus();
		field(container).value = '1';
		await rerender({ page: 7 });
		expect(field(container).value).toBe('1');

		field(container).blur();
		await vi.waitFor(() => expect(field(container).value).toBe('7'));
	});

	it('goes to a page typed within the document, on leaving the field or on Enter', () => {
		const onpage = vi.fn();
		const { container } = render(DocumentPager, { props: { page: 3, pageCount: 12, onpage } });
		enter(container, '12');
		expect(onpage).toHaveBeenLastCalledWith(12);
		enter(container, '1', 'Enter');
		expect(onpage).toHaveBeenLastCalledWith(1);
	});

	// Both edges, a fraction and a blank: a page outside 1..M, or no page, moves nothing, and the field goes
	// back to the page on screen so it never shows a number the view is not on.
	for (const typed of ['0', '13', '2.5', '']) {
		it(`ignores "${typed}" and shows the page on screen again`, () => {
			const onpage = vi.fn();
			const { container } = render(DocumentPager, { props: { page: 3, pageCount: 12, onpage } });
			enter(container, typed);
			expect(onpage).not.toHaveBeenCalled();
			expect(field(container).value).toBe('3');
		});
	}
});
