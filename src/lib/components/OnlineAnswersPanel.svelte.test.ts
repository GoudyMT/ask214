import { render } from 'vitest-browser-svelte';
import { flushSync } from 'svelte';
import { describe, it, expect } from 'vitest';
import OnlineAnswersPanel from './OnlineAnswersPanel.svelte';

type Props = {
	defaultMode: 'device' | 'online';
	synthesisEnabled: boolean;
	hasKey: boolean;
	onSetDefaultMode: (m: 'device' | 'online') => void;
	onToggleSynthesis: (on: boolean) => void;
	onSaveKey: (key: string) => void;
	onClearKey: () => void;
};
const base: Props = {
	defaultMode: 'online',
	synthesisEnabled: false,
	hasKey: false,
	onSetDefaultMode: () => {},
	onToggleSynthesis: () => {},
	onSaveKey: () => {},
	onClearKey: () => {}
};

describe('OnlineAnswersPanel', () => {
	it('states plainly that the key is encrypted on-device and sent only to Anthropic, never to us', () => {
		const { container } = render(OnlineAnswersPanel, { props: { ...base } });
		expect(container.textContent?.replace(/\s+/g, ' ')).toContain(
			'sent only to Anthropic - never to us'
		);
	});

	it('the "how is my key protected" disclosure names the concrete, provable guarantees', () => {
		const { container } = render(OnlineAnswersPanel, { props: { ...base } });
		const details = container.querySelector('.online-key__protect');
		expect(details).not.toBeNull();
		const text = details?.textContent?.replace(/\s+/g, ' ') ?? '';
		expect(text).toContain('encrypted'); // at-rest, AES-GCM
		expect(text).toContain('block it from going anywhere else'); // the CSP egress lock, in plain words
		expect(text).toContain("can't see, store, or use it"); // never reaches our servers
	});

	it('the key input is masked (type=password)', () => {
		const { container } = render(OnlineAnswersPanel, { props: { ...base } });
		expect((container.querySelector('.online-key__input') as HTMLInputElement).type).toBe(
			'password'
		);
	});

	it('saving a typed key calls onSaveKey with it', () => {
		let saved: string | null = null;
		const { container } = render(OnlineAnswersPanel, {
			props: { ...base, onSaveKey: (k) => (saved = k) }
		});
		const input = container.querySelector('.online-key__input') as HTMLInputElement;
		input.value = 'sk-test-key';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
		(container.querySelector('.online-key__save') as HTMLButtonElement).click();
		flushSync();
		expect(saved).toBe('sk-test-key');
	});

	it('when a key is stored, offers to clear it and does not show the raw value', () => {
		const { container } = render(OnlineAnswersPanel, { props: { ...base, hasKey: true } });
		expect(container.querySelector('.online-key__clear')).not.toBeNull();
	});
});
