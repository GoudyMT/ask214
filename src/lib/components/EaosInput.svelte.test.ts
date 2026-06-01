import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import EaosInput from './EaosInput.svelte';
import { scrubSecureInputs } from '../profile/lifecycle';

const baseProps = {
	value: '',
	label: 'Separation date',
	hint: 'The date your service ends.',
	onchange: () => {}
};

describe('EaosInput', () => {
	it('renders a native date input carrying the given value, label, and hint', () => {
		const { container } = render(EaosInput, { props: { ...baseProps, value: '2027-04-30' } });
		const input = container.querySelector('input');
		expect(input?.getAttribute('type')).toBe('date');
		expect(input?.value).toBe('2027-04-30');
		expect(container.textContent).toContain('Separation date');
		expect(container.textContent).toContain('The date your service ends.');
	});

	it('associates the label with the input', () => {
		const { container } = render(EaosInput, { props: baseProps });
		const label = container.querySelector('label');
		const input = container.querySelector('input');
		expect(input?.id).toBeTruthy();
		expect(label?.getAttribute('for')).toBe(input?.id);
	});

	it('calls onchange with the new value on input', () => {
		const onchange = vi.fn();
		const { container } = render(EaosInput, { props: { ...baseProps, onchange } });
		const input = container.querySelector('input');
		if (!input) throw new Error('no input rendered');
		input.value = '2027-04-30';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(onchange).toHaveBeenCalledWith('2027-04-30');
	});

	it('shows the error and marks the input invalid when error is set', () => {
		const { container } = render(EaosInput, {
			props: { ...baseProps, error: 'Enter a valid date' }
		});
		const input = container.querySelector('input');
		const alert = container.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Enter a valid date');
		expect(alert?.id).toBeTruthy();
		expect(input?.getAttribute('aria-invalid')).toBe('true');
		expect(input?.getAttribute('aria-describedby')).toContain(alert?.id);
	});

	it('shows no error and is not marked invalid when error is absent', () => {
		const { container } = render(EaosInput, { props: baseProps });
		const input = container.querySelector('input');
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(input?.getAttribute('aria-invalid')).not.toBe('true');
	});

	it('registers its input so a relock scrub clears the typed value (spec 8 DOM hygiene)', async () => {
		const { container } = render(EaosInput, { props: { ...baseProps, value: '2027-04-15' } });
		const input = container.querySelector('input');
		await tick(); // let the registration $effect run
		expect(input?.value).toBe('2027-04-15');
		scrubSecureInputs();
		expect(input?.value).toBe('');
	});
});
