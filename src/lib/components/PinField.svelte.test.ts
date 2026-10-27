import { render } from 'vitest-browser-svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cdp } from 'vitest/browser';
import PinField from './PinField.svelte';
import type { Relockable } from '../profile/app-init';
import { scrubSecureInputs } from '../profile/lifecycle';

const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};
const SPACE = {
	key: ' ',
	code: 'Space',
	windowsVirtualKeyCode: 32,
	text: String.fromCharCode(32)
};

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function need<T>(value: T | null | undefined): T {
	if (value === null || value === undefined) throw new Error('test setup: value missing');
	return value;
}

type Mounted = Awaited<ReturnType<typeof mount>>;

async function mount(props: Partial<Parameters<typeof PinField>[1]> = {}) {
	const rendered = await render(PinField, { props: { id: 'pin', label: 'PIN', ...props } });
	const { container } = rendered;
	const input = need(container.querySelector<HTMLInputElement>('input'));
	const toggle = need(container.querySelector<HTMLButtonElement>('button'));
	return { ...rendered, input, toggle };
}

function type(input: HTMLInputElement, text: string): void {
	input.value = text;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

async function show(m: Mounted): Promise<void> {
	m.toggle.click();
	await tick();
}

const digitsOf = (m: Mounted): string[] =>
	Array.from(m.container.querySelectorAll('ul li'), (li) => li.textContent ?? '');

/** A key held down: one press, then repeats about every 40 ms, then released. */
async function hold(key: typeof ENTER | typeof SPACE, repeats = 5): Promise<void> {
	const session = cdp();
	await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
	for (let i = 0; i < repeats; i += 1) {
		await pause(40);
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...key });
	}
	await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

function refused(target: Element, type: 'copy' | 'cut'): boolean {
	const e = new ClipboardEvent(type, { bubbles: true, cancelable: true });
	target.dispatchEvent(e);
	return e.defaultPrevented;
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe('what the keyboard and the phone may learn', () => {
	it('is a password field the phone gives a number pad, with no saved-password offer and no spell check', async () => {
		const { input } = await mount();
		expect(input.type).toBe('password');
		expect(input.getAttribute('inputmode')).toBe('numeric');
		expect(input.getAttribute('autocomplete')).toBe('one-time-code');
		expect(input.getAttribute('spellcheck')).toBe('false');
	});

	it('has one input, a label that names it, and no form around it', async () => {
		const m = await mount({ id: 'new-pin', label: 'Choose a 4-6 digit PIN' });
		expect(m.container.querySelectorAll('input')).toHaveLength(1);
		expect(m.container.querySelector('form')).toBeNull();
		expect(m.input.closest('form')).toBeNull();
		expect(m.container.querySelector('label')?.getAttribute('for')).toBe('new-pin');
		expect(m.input.id).toBe('new-pin');
		expect(m.container.querySelector('label')?.textContent).toBe('Choose a 4-6 digit PIN');
	});

	it('refuses copy and cut on the field and on the shown digits', async () => {
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		const list = need(m.container.querySelector('ul'));
		expect([
			refused(m.input, 'copy'),
			refused(m.input, 'cut'),
			refused(list, 'copy'),
			refused(list, 'cut')
		]).toEqual([true, true, true, true]);
	});
});

describe('Enter', () => {
	it('calls onenter once for a held Enter, not once per repeat', async () => {
		const onenter = vi.fn();
		const m = await mount({ onenter });
		m.input.focus();
		await hold(ENTER);
		expect(onenter).toHaveBeenCalledTimes(1);
	});

	// Focus can land here under a key someone is already holding (a button that went away), so the first event this field
	// sees is a repeat: that is not a press of its own.
	it('does not call onenter for repeats of a press that began elsewhere', async () => {
		const onenter = vi.fn();
		const m = await mount({ onenter });
		m.input.focus();
		const session = cdp();
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
		await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
		expect(onenter).not.toHaveBeenCalled();
	});
});

describe('the Show PIN toggle', () => {
	it('is a toggle button that stays Show PIN, and lists the digits as page text while the field stays a password field', async () => {
		const m = await mount();
		type(m.input, '1234');
		expect(m.toggle.textContent?.trim()).toBe('Show PIN');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);

		await show(m);
		expect(m.toggle.textContent?.trim()).toBe('Show PIN');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('true');
		expect(digitsOf(m)).toEqual(['1', '2', '3', '4']);
		expect(m.input.type).toBe('password');

		await show(m);
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
	});

	it('keeps the shown digits in step with what is typed, out of the translator and not selectable', async () => {
		const m = await mount();
		await show(m);
		type(m.input, '90');
		await tick();
		expect(digitsOf(m)).toEqual(['9', '0']);
		const list = need(m.container.querySelector('ul'));
		expect(list.getAttribute('translate')).toBe('no');
		expect(getComputedStyle(list).userSelect).toBe('none');
	});

	it('hides the digits after 5 seconds, not before', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		vi.advanceTimersByTime(4_999);
		await tick();
		expect(m.toggle.getAttribute('aria-pressed')).toBe('true');
		expect(digitsOf(m)).toHaveLength(4);
		vi.advanceTimersByTime(1);
		await tick();
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
		expect(m.input.value).toBe('1234');
	});

	// The first show's timer must not cut a second show short.
	it('gives a second show its own full 5 seconds', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		vi.advanceTimersByTime(3_000);
		await show(m);
		await show(m);
		vi.advanceTimersByTime(4_999);
		await tick();
		expect(m.toggle.getAttribute('aria-pressed')).toBe('true');
	});

	// A held Space already clicks once, on release; this guards that, where Enter's repeats click on every press.
	it.each([
		['Enter', ENTER],
		['Space', SPACE]
	])('flips once for a held %s, not once per repeat', async (_name, key) => {
		const m = await mount();
		type(m.input, '1234');
		let flips = 0;
		const watch = new MutationObserver((records) => (flips += records.length));
		watch.observe(m.toggle, { attributes: true, attributeFilter: ['aria-pressed'] });
		m.toggle.focus();
		await hold(key);
		await pause(0);
		watch.disconnect();
		expect(flips).toBe(1);
	});
});

describe('how long the digits stay in the page', () => {
	it('clear() empties the field and hides the shown digits', async () => {
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		m.component.clear();
		await tick();
		expect(m.input.value).toBe('');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
	});

	it('empties the field before it leaves the page when it is taken out', async () => {
		const m = await mount();
		type(m.input, '1234');
		await m.unmount();
		expect(m.input.value).toBe('');
	});

	it('empties the field and hides the digits on pagehide', async () => {
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		window.dispatchEvent(new Event('pagehide'));
		flushSync();
		expect(m.input.value).toBe('');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
	});

	it('empties the field and hides the digits when the page is hidden, and not when it becomes visible', async () => {
		const m = await mount();
		type(m.input, '1234');
		await show(m);
		const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
		document.dispatchEvent(new Event('visibilitychange'));
		flushSync();
		expect(m.input.value).toBe('1234');
		expect(digitsOf(m)).toHaveLength(4);
		state.mockReturnValue('hidden');
		document.dispatchEvent(new Event('visibilitychange'));
		flushSync();
		expect(m.input.value).toBe('');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
	});

	it('is reached by the app relock scrub while mounted, and not after it is taken out', async () => {
		const m = await mount();
		type(m.input, '1234');
		scrubSecureInputs();
		expect(m.input.value).toBe('');
		await m.unmount();
		m.input.value = 'later';
		scrubSecureInputs();
		expect(m.input.value).toBe('later');
	});

	it('empties the field and hides the digits when the app relocks, and leaves the relock list when taken out', async () => {
		const joined: Relockable[] = [];
		const leave = vi.fn();
		const joinRelock = vi.fn((r: Relockable) => {
			joined.push(r);
			return leave;
		});
		const m = await mount({ joinRelock });
		type(m.input, '1234');
		await show(m);
		expect(joined).toHaveLength(1);
		need(joined[0]).relockSync('user');
		await tick();
		expect(m.input.value).toBe('');
		expect(m.toggle.getAttribute('aria-pressed')).toBe('false');
		expect(digitsOf(m)).toEqual([]);
		expect(leave).not.toHaveBeenCalled();
		await m.unmount();
		expect(leave).toHaveBeenCalledTimes(1);
	});
});

describe('focus', () => {
	it('focus() puts the cursor in the field', async () => {
		const m = await mount();
		m.component.focus();
		await vi.waitFor(() => expect(document.activeElement).toBe(m.input));
	});
});
