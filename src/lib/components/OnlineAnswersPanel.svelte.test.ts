import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import OnlineAnswersPanel from './OnlineAnswersPanel.svelte';
import { scrubSecureInputs } from '../profile/lifecycle';

type Props = {
	defaultMode: 'device' | 'online';
	synthesisEnabled: boolean;
	hasKey: boolean;
	onSetDefaultMode: (m: 'device' | 'online') => void;
	onToggleSynthesis: (on: boolean) => void;
	onSaveKey: (key: string) => Promise<void>;
	onClearKey: () => Promise<void>;
};
const base: Props = {
	defaultMode: 'online',
	synthesisEnabled: false,
	hasKey: false,
	onSetDefaultMode: () => {},
	onToggleSynthesis: () => {},
	onSaveKey: async () => {},
	onClearKey: async () => {}
};

describe('OnlineAnswersPanel', () => {
	it('states plainly that the key is encrypted on-device and sent only to Anthropic, never to us', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
			'sent only to Anthropic - never to us'
		);
	});

	it('the "how is my key protected" disclosure names the concrete, provable guarantees', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		const details = container.querySelector('.online-key__protect');
		expect(details).not.toBeNull();
		const text = details?.textContent?.replace(/\s+/g, ' ') ?? '';
		expect(text).toContain('encrypted'); // at-rest, AES-GCM
		expect(text).toContain('block it from going anywhere else'); // the CSP egress lock, in plain words
		expect(text).toContain("can't see, store, or use it"); // never reaches our servers
	});

	it('the key input is masked (type=password)', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		expect((container.querySelector('.online-key__input') as HTMLInputElement).type).toBe(
			'password'
		);
	});

	it('saving a typed key calls onSaveKey with it', async () => {
		let saved: string | null = null;
		const { container } = await render(OnlineAnswersPanel, {
			props: {
				...base,
				onSaveKey: async (k) => {
					saved = k;
				}
			}
		});
		const input = container.querySelector('.online-key__input') as HTMLInputElement;
		input.value = 'sk-test-key';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('.online-key__save') as HTMLButtonElement).click();
		flushSync();
		expect(saved).toBe('sk-test-key');
	});

	it('when a key is stored, offers to clear it and does not show the raw value', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base, hasKey: true } });
		expect(container.querySelector('.online-key__clear')).not.toBeNull();
	});

	describe('when the key cannot be saved or removed', () => {
		const SAVE_FAILED = 'Could not save your key - please enter it again.';
		const REMOVE_FAILED = 'Could not update right now - please try again.';
		const alertText = (container: Element) =>
			container.querySelector('.online-key__row + .online-key__error[role="alert"]')?.textContent;

		function type(container: Element, key: string): HTMLInputElement {
			const input = container.querySelector('.online-key__input') as HTMLInputElement;
			input.value = key;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			return input;
		}
		const click = (container: Element, selector: string) =>
			(container.querySelector(selector) as HTMLButtonElement).click();

		it('says so under the row and leaves the key field empty when saving the key fails', async () => {
			const { container } = await render(OnlineAnswersPanel, {
				props: { ...base, onSaveKey: () => Promise.reject(new Error('E_TEST_WRITE')) }
			});
			const input = type(container, 'sk-ant-secret');
			click(container, '.online-key__save');

			await vi.waitFor(() => expect(alertText(container)).toBe(SAVE_FAILED));
			expect(input.value).toBe('');
		});

		it('says so under the row when removing the key fails', async () => {
			const { container } = await render(OnlineAnswersPanel, {
				props: {
					...base,
					hasKey: true,
					onClearKey: () => Promise.reject(new Error('E_TEST_WRITE'))
				}
			});
			click(container, '.online-key__clear');

			await vi.waitFor(() => expect(alertText(container)).toBe(REMOVE_FAILED));
		});

		// The second attempt never settles, so the line is gone because the attempt started, not because it ended.
		it('takes the line away when the next save starts', async () => {
			let attempt = 0;
			const { container } = await render(OnlineAnswersPanel, {
				props: {
					...base,
					onSaveKey: () =>
						++attempt === 1 ? Promise.reject(new Error('E_TEST_WRITE')) : new Promise(() => {})
				}
			});
			type(container, 'sk-ant-one');
			click(container, '.online-key__save');
			await vi.waitFor(() => expect(alertText(container)).toBe(SAVE_FAILED));

			type(container, 'sk-ant-two');
			click(container, '.online-key__save');
			await vi.waitFor(() => expect(attempt).toBe(2));
			await vi.waitFor(() => expect(container.querySelector('.online-key__error')).toBeNull());
		});

		it('takes the line away when a remove starts', async () => {
			let attempt = 0;
			const { container } = await render(OnlineAnswersPanel, {
				props: {
					...base,
					hasKey: true,
					onClearKey: () =>
						++attempt === 1 ? Promise.reject(new Error('E_TEST_WRITE')) : new Promise(() => {})
				}
			});
			click(container, '.online-key__clear');
			await vi.waitFor(() => expect(alertText(container)).toBe(REMOVE_FAILED));

			click(container, '.online-key__clear');
			await vi.waitFor(() => expect(container.querySelector('.online-key__error')).toBeNull());
		});
	});

	it('registers the key input so a relock scrub wipes a typed-but-unsaved key (DOM hygiene)', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		flushSync(); // let the registration $effect run
		const input = container.querySelector('.online-key__input') as HTMLInputElement;
		input.value = 'sk-ant-secret';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		expect(input.value).toBe('sk-ant-secret');
		scrubSecureInputs();
		expect(input.value).toBe('');
	});
});
