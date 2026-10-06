import { describe, it, expect, afterEach } from 'vitest';
import { installGlobalErrorSanitizer } from './global-errors';
import { getDiagnosticsForTest } from './safelog';

describe('installGlobalErrorSanitizer', () => {
	let remove: (() => void) | undefined;
	afterEach(() => remove?.());

	it('stops the browser reporting an escaped error and logs only E_INTERNAL', () => {
		remove = installGlobalErrorSanitizer(window);
		const before = getDiagnosticsForTest().length;
		const ev = new ErrorEvent('error', { message: 'bad date 2026-11-01', cancelable: true });
		window.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		const added = getDiagnosticsForTest().slice(before);
		expect(added.map((e) => e.code)).toEqual(['E_INTERNAL']);
		expect(JSON.stringify(added)).not.toContain('2026-11-01');
	});

	it('does the same for an unhandled rejection', () => {
		remove = installGlobalErrorSanitizer(window);
		const before = getDiagnosticsForTest().length;
		const ev = new PromiseRejectionEvent('unhandledrejection', {
			promise: Promise.resolve(),
			reason: new Error('bad date 2026-11-01'),
			cancelable: true
		});
		window.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(
			getDiagnosticsForTest()
				.slice(before)
				.map((e) => e.code)
		).toEqual(['E_INTERNAL']);
	});

	it('takes both listeners off when removed', () => {
		installGlobalErrorSanitizer(window)();
		const error = new ErrorEvent('error', { message: 'x', cancelable: true });
		const rejection = new PromiseRejectionEvent('unhandledrejection', {
			promise: Promise.resolve(),
			reason: null,
			cancelable: true
		});
		window.dispatchEvent(error);
		window.dispatchEvent(rejection);
		expect(error.defaultPrevented).toBe(false);
		expect(rejection.defaultPrevented).toBe(false);
	});
});
