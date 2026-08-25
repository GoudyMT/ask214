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
	it('renders message, include-page (checked), optional email, submit', () => {
		const { container } = render(FeedbackForm, {
			props: { submit: vi.fn(), attachedRoute: '/timeline' }
		});
		expect(container.querySelector('textarea')).toBeTruthy();
		const check = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
		expect(check.checked).toBe(true);
		expect(container.querySelector('input[type="email"]')).toBeTruthy();
		expect(container.textContent ?? '').toMatch(/Timeline/);
	});

	it('does not submit an empty message; shows inline validation', () => {
		const submit = vi.fn();
		const { container } = render(FeedbackForm, { props: { submit, attachedRoute: '/timeline' } });
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		flushSync();
		expect(submit).not.toHaveBeenCalled();
		expect(container.textContent ?? '').toMatch(/enter a message/i);
	});

	it('submits message + route when the box is checked', async () => {
		const submit = vi.fn().mockResolvedValue({ ok: true });
		const { container } = render(FeedbackForm, { props: { submit, attachedRoute: '/timeline' } });
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => expect(submit).toHaveBeenCalled());
		expect(submit.mock.calls[0]?.[0]).toMatchObject({ message: 'hi', route: '/timeline' });
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

	it('shows the success panel after a successful submit', async () => {
		const { container } = render(FeedbackForm, {
			props: { submit: vi.fn().mockResolvedValue({ ok: true }), attachedRoute: '/timeline' }
		});
		fill(container, 'textarea', 'hi');
		(container.querySelector('form') as HTMLFormElement).requestSubmit();
		await vi.waitFor(() => {
			flushSync();
			expect(container.textContent ?? '').toMatch(/your feedback was sent/i);
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
