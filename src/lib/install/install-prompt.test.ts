import { describe, it, expect, vi } from 'vitest';
import {
	createInstallController,
	type InstallControllerDeps,
	type BeforeInstallPromptEvent
} from './install-prompt';

type Handlers = Record<string, ((e: Event) => void) | undefined>;

/** A fake event target recording handlers so a test can fire synthetic events + assert removal. */
function fakeTarget() {
	const handlers: Handlers = {};
	const target: InstallControllerDeps['target'] = {
		addEventListener: (type, cb) => {
			handlers[type] = cb;
		},
		removeEventListener: (type) => {
			handlers[type] = undefined;
		}
	};
	return {
		target,
		fire: (type: string, e: Record<string, unknown>) => handlers[type]?.(e as unknown as Event),
		has: (type: string) => handlers[type] !== undefined
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

function make(over: Partial<InstallControllerDeps> = {}) {
	const t = fakeTarget();
	const onChange = vi.fn();
	const controller = createInstallController({
		target: t.target,
		isInstalled: () => false,
		onChange,
		...over
	});
	return { controller, onChange, ...t };
}

describe('createInstallController', () => {
	it('starts with canPrompt false and installed reflecting the dep', () => {
		const { controller } = make({ isInstalled: () => true });
		expect(controller.snapshot()).toEqual({ canPrompt: false, installed: true });
	});

	it('seeds canPrompt from an event captured before init (the app.html early capture)', () => {
		// beforeinstallprompt can fire during load, before this controller exists; initialPrompt reads
		// what the early script stashed so a returning user does not lose the one-shot event.
		const evt = fakePromptEvent() as unknown as BeforeInstallPromptEvent;
		const { controller } = make({ initialPrompt: () => evt });
		expect(controller.snapshot().canPrompt).toBe(true);
	});

	it('captures a later beforeinstallprompt: prevents the mini-infobar, flips canPrompt, notifies', () => {
		const { controller, onChange, fire } = make();
		const evt = fakePromptEvent();
		fire('beforeinstallprompt', evt);
		expect(evt.preventDefault).toHaveBeenCalledOnce();
		expect(controller.snapshot().canPrompt).toBe(true);
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('promptInstall triggers the stashed prompt, returns the choice, and clears canPrompt', async () => {
		const { controller, fire } = make();
		const evt = fakePromptEvent('accepted');
		fire('beforeinstallprompt', evt);
		const outcome = await controller.promptInstall();
		expect(evt.prompt).toHaveBeenCalledOnce();
		expect(outcome).toBe('accepted');
		expect(controller.snapshot().canPrompt).toBe(false);
	});

	it('promptInstall returns unavailable when nothing was captured (iOS)', async () => {
		const { controller } = make();
		expect(await controller.promptInstall()).toBe('unavailable');
	});

	it('swallows a rejected prompt() to unavailable rather than an unhandled rejection', async () => {
		const { controller, fire } = make();
		const evt = {
			...fakePromptEvent(),
			prompt: vi.fn().mockRejectedValue(new Error('no gesture'))
		};
		fire('beforeinstallprompt', evt);
		expect(await controller.promptInstall()).toBe('unavailable');
	});

	it('appinstalled marks installed, clears canPrompt, and notifies', () => {
		const { controller, onChange, fire } = make();
		fire('beforeinstallprompt', fakePromptEvent());
		onChange.mockClear();
		fire('appinstalled', { type: 'appinstalled' });
		expect(controller.snapshot()).toEqual({ canPrompt: false, installed: true });
		expect(onChange).toHaveBeenCalledOnce();
	});

	it('destroy removes both window listeners', () => {
		const { controller, has } = make();
		expect(has('beforeinstallprompt')).toBe(true);
		controller.destroy();
		expect(has('beforeinstallprompt')).toBe(false);
		expect(has('appinstalled')).toBe(false);
	});
});
