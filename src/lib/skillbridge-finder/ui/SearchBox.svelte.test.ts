import { render } from 'vitest-browser-svelte';
import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import SearchBox from './SearchBox.svelte';

const offer = (over: Partial<{ bytes: number; busy: boolean }> = {}) => ({
	bytes: 2_400_000,
	busy: false,
	onaccept: vi.fn(),
	ondecline: vi.fn(),
	...over
});

describe('the field', () => {
	it('is labelled and says what can be typed', async () => {
		await render(SearchBox, { value: 'abc' });
		const field = page.getByLabelText('Search programs');

		await expect.element(field).toHaveValue('abc');
		await expect.element(field).toHaveAttribute('placeholder', 'Company, role, place or job code');
	});

	it('shows no question when there is none', async () => {
		await render(SearchBox, { value: '' });

		await expect.element(page.getByText('Search every region?')).not.toBeInTheDocument();
	});
});

describe('the search-every-region question', () => {
	it('names the download size from the index, in megabytes', async () => {
		await render(SearchBox, { value: 'a', offer: offer() });

		await expect.element(page.getByText(/about 2.4 MB of listings once/)).toBeVisible();
	});

	it.each([
		[15_000_000, '15'],
		[2_449_999, '2.4'],
		[10, '0.1']
	])('words %i bytes as %s MB', async (bytes, words) => {
		await render(SearchBox, { value: 'a', offer: offer({ bytes }) });

		await expect.element(page.getByText(`about ${words} MB of listings once`)).toBeVisible();
	});

	it('asks only when the button is pressed, and drops the question on Near me only', async () => {
		const o = offer();
		await render(SearchBox, { value: 'a', offer: o });
		expect(o.onaccept).not.toHaveBeenCalled();

		await page.getByRole('button', { name: 'Near me only' }).click();
		expect(o.ondecline).toHaveBeenCalledOnce();
		expect(o.onaccept).not.toHaveBeenCalled();

		await page.getByRole('button', { name: 'Search every region' }).click();
		expect(o.onaccept).toHaveBeenCalledOnce();
	});

	// A second tap while the files are coming must not start a second download.
	it('says it is downloading and ignores a press meanwhile', async () => {
		const o = offer({ busy: true });
		await render(SearchBox, { value: 'a', offer: o });
		await page.getByRole('button', { name: 'Downloading...' }).click();

		expect(o.onaccept).not.toHaveBeenCalled();
	});
});
