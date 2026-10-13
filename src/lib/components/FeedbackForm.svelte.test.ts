import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import { cdp, userEvent } from 'vitest/browser';
import FeedbackForm from './FeedbackForm.svelte';

function fill(container: Element, selector: string, value: string) {
	const el = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('FeedbackForm', () => {
	it('renders message, include-page (checked), optional email, submit, and a hidden honeypot', async () => {
		const { container } = await render(FeedbackForm, {
			props: { submit: vi.fn(), attachedRoute: '/timeline' }
		});
		expect(container.querySelector('textarea')).toBeTruthy();
		const check = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(check.checked).toBe(true);
		expect(container.querySelector('input[type="email"]')).toBeTruthy();
		expect(container.textContent ?? '').toMatch(/Timeline/);
		// The honeypot exists but is hidden from people (aria-hidden + not tabbable).
		const hp = container.querySelector('#fb-hp') as HTMLInputElement;
		expect(hp).toBeTruthy();
		expect(hp.getAttribute('tabindex')).toBe('-1');
		expect(container.querySelector('.hp')?.getAttribute('aria-hidden')).toBe('true');
	});

	it('does not submit an empty message; announces + associates the inline error', async () => {
		const submit = vi.fn();
		const { container } = await render(FeedbackForm, {
			props: { submit, attachedRoute: '/timeline' }
		});
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		flushSync();
		expect(submit).not.toHaveBeenCalled();
		const err = container.querySelector('#fb-msg-error');
		expect(err?.getAttribute('role')).toBe('alert');
		expect(err?.textContent ?? '').toMatch(/enter a message/i);
		const ta = container.querySelector('textarea') as HTMLTextAreaElement;
		expect(ta.getAttribute('aria-invalid')).toBe('true');
		expect(ta.getAttribute('aria-describedby')).toBe('fb-msg-error');
	});

	it('clears the inline error as the user types', async () => {
		const { container } = await render(FeedbackForm, {
			props: { submit: vi.fn(), attachedRoute: '/timeline' }
		});
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		flushSync();
		expect(container.querySelector('#fb-msg-error')).toBeTruthy();
		fill(container, 'textarea', 'x');
		expect(container.querySelector('#fb-msg-error')).toBeNull();
	});

	it('submits message + route + honeypot when the box is checked', async () => {
		const submit = vi.fn().mockResolvedValue({ ok: true });
		const { container } = await render(FeedbackForm, {
			props: { submit, attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(submit).toHaveBeenCalled());
		expect(submit.mock.calls[0]?.[0]).toMatchObject({
			message: 'hi',
			route: '/timeline',
			honeypot: ''
		});
	});

	it('omits the route when the box is unchecked', async () => {
		const submit = vi.fn().mockResolvedValue({ ok: true });
		const { container } = await render(FeedbackForm, {
			props: { submit, attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		const check = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		check.click();
		flushSync();
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(submit).toHaveBeenCalled());
		expect(submit.mock.calls[0]?.[0]?.route).toBeNull();
	});

	it('shows the success panel and focuses its heading after a successful submit', async () => {
		const { container } = await render(FeedbackForm, {
			props: { submit: vi.fn().mockResolvedValue({ ok: true }), attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => {
			flushSync();
			const h2 = container.querySelector('.panel h2');
			expect(h2?.textContent ?? '').toMatch(/your feedback was sent/i);
			expect(h2?.getAttribute('tabindex')).toBe('-1');
			expect(document.activeElement).toBe(h2); // the $effect actually moved focus, not just markup
		});
	});

	it('shows the error panel + a mailto fallback when submit fails', async () => {
		const { container } = await render(FeedbackForm, {
			props: { submit: vi.fn().mockResolvedValue({ ok: false }), attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => {
			flushSync();
			expect(container.querySelector('a[href^="mailto:"]')).toBeTruthy();
		});
	});

	it('hides the include-page row when no route is attached', async () => {
		const { container } = await render(FeedbackForm, {
			props: { submit: vi.fn(), attachedRoute: null }
		});
		expect(container.querySelector('input[type="checkbox"]')).toBeNull();
	});
});

// Enter as a keyboard sends it: the key, its code and the carriage return it types.
const ENTER = {
	key: 'Enter',
	code: 'Enter',
	windowsVirtualKeyCode: 13,
	text: String.fromCharCode(13)
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const TIMINGS = [
	['ends at once', 0],
	['takes a while', 100]
] as const;

// A held Enter: one press, then repeats about every 40 ms, then the key up.
async function holdEnter() {
	const session = cdp();
	await session.send('Input.dispatchKeyEvent', { type: 'keyDown', ...ENTER });
	for (let i = 0; i < 6; i++) {
		await pause(40);
		await session.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...ENTER });
	}
	await session.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ENTER });
}

const message = (container: Element) => container.querySelector<HTMLTextAreaElement>('#fb-msg');
const button = (container: Element, name: string) =>
	[...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) ?? null;

// A form that has sent (or failed to send) 'hi', showing its outcome panel.
async function afterSend(ok: boolean) {
	const view = await render(FeedbackForm, {
		props: { submit: vi.fn().mockResolvedValue({ ok }), attachedRoute: '/timeline' }
	});
	fill(view.container, 'textarea', 'hi');
	view.container.querySelector('form')?.requestSubmit();
	await vi.waitFor(() => expect(view.container.querySelector('.panel')).not.toBeNull());
	return view;
}

describe('FeedbackForm, focus', () => {
	it.each([
		['Send another', true, ''],
		['Try again', false, 'hi']
	] as const)(
		'puts focus back in the message box when %s is pressed by keyboard',
		async (name, ok, kept) => {
			const { container } = await afterSend(ok);
			button(container, name)?.focus();
			await userEvent.keyboard('{Enter}');

			await expect.poll(() => document.activeElement).toBe(message(container));
			expect(message(container)?.value).toBe(kept);
		}
	);

	it.each([
		['Send another', true],
		['Try again', false]
	] as const)('moves no focus to the message box when %s is tapped', async (name, ok) => {
		const { container } = await afterSend(ok);
		await userEvent.click(button(container, name)!);

		await vi.waitFor(() => expect(message(container)).not.toBeNull());
		await pause(50);
		expect(document.activeElement).not.toBe(message(container));
	});

	// The button hands focus to the box, so the held key's repeats land there: they must not type new lines.
	it.each([
		['Send another', true, ''],
		['Try again', false, 'hi']
	] as const)('types nothing into the box for a held Enter on %s', async (name, ok, kept) => {
		const { container } = await afterSend(ok);
		button(container, name)?.focus();
		await holdEnter();

		expect(document.activeElement).toBe(message(container));
		expect(message(container)?.value).toBe(kept);
	});

	// The button that holds focus is not turned off for the work, or the focus falls to the page.
	it('keeps Send enabled, reading "Sending...", while the message goes, and sends once', async () => {
		const submit = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
		const { container } = await render(FeedbackForm, { props: { submit, attachedRoute: null } });
		fill(container, 'textarea', 'hi');
		const send = button(container, 'Send feedback')!;
		send.focus();
		await userEvent.keyboard('{Enter}');

		await vi.waitFor(() => expect(send.textContent?.trim()).toBe('Sending...'));
		expect(send.disabled).toBe(false);
		// Still announced as off, and still dimmed, as the disabled button was.
		expect(send.getAttribute('aria-disabled')).toBe('true');
		expect(document.activeElement).toBe(send);
		await userEvent.keyboard('{Enter}');
		await pause(50);
		expect(submit).toHaveBeenCalledOnce();
	});

	it.each(TIMINGS)('sends once for a held Enter on Send when the work %s', async (_, ms) => {
		const submit = vi.fn(
			() => new Promise<{ ok: boolean }>((resolve) => setTimeout(() => resolve({ ok: true }), ms))
		);
		const { container } = await render(FeedbackForm, { props: { submit, attachedRoute: null } });
		fill(container, 'textarea', 'hi');
		button(container, 'Send feedback')?.focus();
		await holdEnter();
		await pause(ms + 50);

		expect(submit).toHaveBeenCalledOnce();
	});

	it('leaves focus where the person moved it while the message went', async () => {
		let finish: (r: { ok: boolean }) => void = () => {};
		const submit = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => (finish = resolve)));
		const elsewhere = document.body.appendChild(document.createElement('button'));
		try {
			const { container } = await render(FeedbackForm, { props: { submit, attachedRoute: null } });
			fill(container, 'textarea', 'hi');
			container.querySelector('form')?.requestSubmit();
			await vi.waitFor(() => expect(submit).toHaveBeenCalled());
			elsewhere.focus();
			finish({ ok: true });

			await vi.waitFor(() => expect(container.querySelector('.panel')).not.toBeNull());
			await pause(50);
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});
});
