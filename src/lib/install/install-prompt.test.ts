import { describe, it, expect, vi } from 'vitest';
import { createInstallController, type InstallControllerDeps } from './install-prompt';

type Handlers = Record<string, ((e: Event) => void) | undefined>;

/** A fake event target that records handlers so a test can fire synthetic events at the controller. */
function fakeTarget() {
	const handlers: Handlers = {};
	const target: InstallControllerDeps['target'] = {
		addEventListener: (type, cb) => {
			handlers[type] = cb;
		}
	};
	return {
		target,
		fire: (type: string, e: Record<string, unknown>) => handlers[type]?.(e as unknown as Event)
	};
}

function fakePromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted') {
	return {
		type: 'beforeinstallprompt',
		preventDefault: vi.fn(),
		prompt: vi.fn().mockResolvedValue(undefined),
		userChoice: Promise.resolve({ outcome })
	};
}

describe('createInstallController', () => {
	it('starts with canPrompt false and installed reflecting the dep', () => {
		const { target } = fakeTarget();
		const c = createInstallController({ target, isInstalled: () => true });
		expect(c.snapshot()).toEqual({ canPrompt: false, installed: true });
	});

	it('captures beforeinstallprompt: prevents the mini-infobar, flips canPrompt, notifies', () => {
		// The event fires once, early; we must preventDefault (suppress the browser mini-infobar) and
		// stash it so a later user gesture can trigger the real prompt.
		const { target, fire } = fakeTarget();
		const c = createInstallController({ target, isInstalled: () => false });
		const onChange = vi.fn();
		c.subscribe(onChange);
		const evt = fakePromptEvent();
		fire('beforeinstallprompt', evt);
		expect(evt.preventDefault).toHaveBeenCalledOnce();
		expect(c.snapshot().canPrompt).toBe(true);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('promptInstall triggers the stashed prompt, returns the choice, and clears canPrompt', async () => {
		const { target, fire } = fakeTarget();
		const c = createInstallController({ target, isInstalled: () => false });
		const evt = fakePromptEvent('accepted');
		fire('beforeinstallprompt', evt);
		const outcome = await c.promptInstall();
		expect(evt.prompt).toHaveBeenCalledOnce();
		expect(outcome).toBe('accepted');
		// a beforeinstallprompt event can only be used once
		expect(c.snapshot().canPrompt).toBe(false);
	});

	it('promptInstall returns unavailable when nothing was captured (e.g. iOS)', async () => {
		const { target } = fakeTarget();
		const c = createInstallController({ target, isInstalled: () => false });
		expect(await c.promptInstall()).toBe('unavailable');
	});

	it('appinstalled marks installed, clears canPrompt, and notifies', () => {
		const { target, fire } = fakeTarget();
		const c = createInstallController({ target, isInstalled: () => false });
		fire('beforeinstallprompt', fakePromptEvent());
		const onChange = vi.fn();
		c.subscribe(onChange);
		fire('appinstalled', { type: 'appinstalled' });
		expect(c.snapshot()).toEqual({ canPrompt: false, installed: true });
		expect(onChange).toHaveBeenCalledOnce();
	});
});
