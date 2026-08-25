import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import { flushSync } from 'svelte';
import FeedbackForm from './FeedbackForm.svelte';

function fill(container: Element, selector: string, value: string) {
	const el = container.querySelector(selector) as HTMLInputElement | HTMLTextAreaElement;
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('FeedbackForm', () => {
	it('renders message, include-page (checked), optional email, submit, and a hidden honeypot', () => {
		const { container } = render(FeedbackForm, {
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

	it('does not submit an empty message; announces + associates the inline error', () => {
		const submit = vi.fn();
		const { container } = render(FeedbackForm, { props: { submit, attachedRoute: '/timeline' } });
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

	it('clears the inline error as the user types', () => {
		const { container } = render(FeedbackForm, {
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
		const { container } = render(FeedbackForm, { props: { submit, attachedRoute: '/timeline' } });
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
		const { container } = render(FeedbackForm, { props: { submit, attachedRoute: '/timeline' } });
		fill(container, 'textarea', 'hi');
		const check = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		check.click();
		flushSync();
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(submit).toHaveBeenCalled());
		expect(submit.mock.calls[0]?.[0]?.route).toBeNull();
	});

	it('shows the success panel and focuses its heading after a successful submit', async () => {
		const { container } = render(FeedbackForm, {
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
		const { container } = render(FeedbackForm, {
			props: { submit: vi.fn().mockResolvedValue({ ok: false }), attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => {
			flushSync();
			expect(container.querySelector('a[href^="mailto:"]')).toBeTruthy();
		});
	});

	it('hides the include-page row when no route is attached', () => {
		const { container } = render(FeedbackForm, { props: { submit: vi.fn(), attachedRoute: null } });
		expect(container.querySelector('input[type="checkbox"]')).toBeNull();
	});
});
