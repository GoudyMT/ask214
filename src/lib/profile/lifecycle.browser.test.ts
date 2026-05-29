import { describe, it, expect } from 'vitest';
import { registerSecureInput, scrubSecureInputs } from './lifecycle';

describe('scrubSecureInputs + registerSecureInput', () => {
	it('clears the value of every registered input', () => {
		const a = document.createElement('input');
		a.type = 'text';
		a.value = 'pii-text';
		const b = document.createElement('input');
		b.type = 'password';
		b.value = 'secret-passphrase';

		registerSecureInput(a);
		registerSecureInput(b);
		scrubSecureInputs();

		expect(a.value).toBe('');
		expect(b.value).toBe('');
	});

	it('unregister stops a node from being scrubbed', () => {
		const el = document.createElement('input');
		const unregister = registerSecureInput(el);
		unregister();
		el.value = 'set-after-unregister';
		scrubSecureInputs();
		expect(el.value).toBe('set-after-unregister');
	});
});
