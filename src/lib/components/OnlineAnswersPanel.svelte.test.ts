import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
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
	// A 44 px target without a bigger pill, as on the theme pills.
	it('takes a tap 22 px above or below the middle of each answer mode button, with the pill under 44 px', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		(container as HTMLElement).style.padding = '40px';
		for (const b of container.querySelectorAll('.online-mode__opt')) {
			const r = b.getBoundingClientRect();
			const x = r.left + r.width / 2;
			const mid = r.top + r.height / 2;
			expect(r.height).toBeLessThan(44);
			expect(document.elementFromPoint(x, mid - 21.5)).toBe(b);
			expect(document.elementFromPoint(x, mid + 21.5)).toBe(b);
		}
	});

	// Forced colors drop the accent fill that marks the chosen mode, so there a ring marks it, as on the theme pills.
	it('marks the chosen answer mode by a 3 px ring in forced colors only', async () => {
		const { container } = await render(OnlineAnswersPanel, {
			props: { ...base, defaultMode: 'device' }
		});
		const buttons = [...container.querySelectorAll<HTMLButtonElement>('.online-mode__opt')];
		const rings = () =>
			buttons.map((b) =>
				getComputedStyle(b).borderTopStyle === 'none' ? 'none' : getComputedStyle(b).borderTopWidth
			);
		const sizes = () =>
			buttons.map((b) => [b.getBoundingClientRect().width, b.getBoundingClientRect().height]);
		expect(rings()).toEqual(['none', 'none']);
		const before = sizes();
		const session = cdp();
		await session.send('Emulation.setEmulatedMedia', {
			features: [{ name: 'forced-colors', value: 'active' }]
		});
		try {
			await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(true);
			expect(rings()).toEqual(['none', '3px']);
			const probe = document.createElement('span');
			probe.style.color = 'Highlight';
			document.body.append(probe);
			expect(getComputedStyle(buttons[1]!).borderTopColor).toBe(getComputedStyle(probe).color);
			probe.remove();
			expect(sizes()).toEqual(before);
		} finally {
			await session.send('Emulation.setEmulatedMedia', {
				features: [{ name: 'forced-colors', value: 'none' }]
			});
		}
		await expect.poll(() => matchMedia('(forced-colors: active)').matches).toBe(false);
		expect(rings()).toEqual(['none', 'none']);
	});

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
		input.value = 'sk-ant-test-key';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('.online-key__save') as HTMLButtonElement).click();
		flushSync();
		expect(saved).toBe('sk-ant-test-key');
	});

	// Load-bearing: a password manager must not offer to store or fill an API key.
	it('the key input keeps autocomplete off', async () => {
		const { container } = await render(OnlineAnswersPanel, { props: { ...base } });
		expect(
			(container.querySelector('.online-key__input') as HTMLInputElement).getAttribute(
				'autocomplete'
			)
		).toBe('off');
	});

	describe('a value that is not an Anthropic key', () => {
		const NOT_A_KEY =
			'That is not an Anthropic API key. Keys start with sk-ant-. Nothing was saved.';

		async function typeAndSave(typed: string) {
			const onSaveKey = vi.fn<Props['onSaveKey']>(async () => {});
			const { container } = await render(OnlineAnswersPanel, { props: { ...base, onSaveKey } });
			const input = container.querySelector('.online-key__input') as HTMLInputElement;
			input.value = typed;
			input.dispatchEvent(new Event('input', { bubbles: true }));
			flushSync();
			(container.querySelector('.online-key__save') as HTMLButtonElement).click();
			flushSync();
			return { container, input, onSaveKey };
		}

		it('a value not starting sk-ant- is refused, cleared and not saved', async () => {
			const { container, input, onSaveKey } = await typeAndSave('sk-test-key');

			expect(onSaveKey).not.toHaveBeenCalled();
			expect(input.value).toBe('');
			expect(container.querySelector('.online-key__error[role="alert"]')?.textContent).toBe(
				NOT_A_KEY
			);
		});

		it('six lowercase words are refused', async () => {
			const { container, input, onSaveKey } = await typeAndSave('apple harbor cable dog echo fox');

			expect(onSaveKey).not.toHaveBeenCalled();
			expect(input.value).toBe('');
			expect(container.querySelector('.online-key__error[role="alert"]')?.textContent).toBe(
				NOT_A_KEY
			);
		});

		it('the refusal never contains the value', async () => {
			const { container } = await typeAndSave('apple harbor cable dog echo fox');

			const text = container.textContent ?? '';
			expect(text).toContain(NOT_A_KEY);
			for (const word of ['apple', 'harbor', 'cable', 'dog', 'echo', 'fox']) {
				expect(text).not.toContain(word);
			}
		});
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

	// The Remove button goes with the key it removes; focus goes to the key field, where a new key is typed, instead of
	// falling to the page, for a person on a keyboard. A tap leaves it: a focused text field would open a phone's on-screen
	// keyboard. The parent turns hasKey off when the removal lands, as the rerender here does.
	describe('after Remove', () => {
		const remove = () => page.getByRole('button', { name: 'Remove' });
		async function pressRemoveByKey(): Promise<void> {
			(remove().element() as HTMLElement).focus();
			await userEvent.keyboard('{Enter}');
		}
		async function renderRemovable(ms: number): Promise<void> {
			const props: Props = { ...base, hasKey: true };
			const screen = await render(OnlineAnswersPanel, {
				props: {
					...props,
					onClearKey: async () => {
						await new Promise((resolve) => setTimeout(resolve, ms));
						await screen.rerender({ ...props, hasKey: false });
					}
				}
			});
		}

		it('hands focus to the key field when the removal lands', async () => {
			await renderRemovable(50);
			await pressRemoveByKey();

			await expect
				.poll(() => document.activeElement)
				.toBe(document.getElementById('online-key-input'));
			expect(remove().query()).toBeNull();
		});

		// A screen reader's browse mode presses a button with a click that carries no pointer (detail 0), and no focus ring
		// when the last real input was a pointer: it is a press without a tap, so the field takes focus.
		it("hands focus to the key field when a screen reader's click presses Remove", async () => {
			await renderRemovable(50);
			await page.getByLabelText('Your Anthropic API key').click();
			const button = remove().element() as HTMLElement;
			button.focus();
			button.click();

			await expect
				.poll(() => document.activeElement)
				.toBe(document.getElementById('online-key-input'));
		});

		it('leaves the key field alone when Remove was pressed by pointer', async () => {
			await renderRemovable(50);
			await remove().click();

			await expect.poll(() => remove().query()).toBeNull();
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(document.activeElement).not.toBe(document.getElementById('online-key-input'));
		});

		it('leaves focus alone when the person moved it while the removal ran', async () => {
			await renderRemovable(100);
			const elsewhere = document.body.appendChild(document.createElement('button'));
			try {
				await pressRemoveByKey();
				elsewhere.focus();
				await expect.poll(() => remove().query()).toBeNull();
				await new Promise((resolve) => setTimeout(resolve, 50));
				expect(document.activeElement).toBe(elsewhere);
			} finally {
				elsewhere.remove();
			}
		});

		// Guard: a removal that fails leaves the button where it is, with the line that says so.
		it('keeps focus on Remove, with the line, when the removal fails', async () => {
			const { container } = await render(OnlineAnswersPanel, {
				props: {
					...base,
					hasKey: true,
					onClearKey: () => Promise.reject(new Error('E_TEST_WRITE'))
				}
			});
			await remove().click();

			await vi.waitFor(() =>
				expect(container.querySelector('.online-key__error')?.textContent).toBe(
					'Could not update right now - please try again.'
				)
			);
			await expect.poll(() => document.activeElement).toBe(remove().element());
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
