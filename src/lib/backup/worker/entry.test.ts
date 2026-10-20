import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORDS_V1 } from '../words-v1';
import { installWorker } from './entry';
import type { WorkerScope } from './entry';
import type { FromWorker } from './protocol';

const mocks = vi.hoisted(() => ({ createHandler: vi.fn(), handle: vi.fn() }));
vi.mock('./handler', () => ({ createHandler: mocks.createHandler }));

type FakeEvent = { data?: unknown; preventDefault: ReturnType<typeof vi.fn> };

function fakeScope() {
	const listeners = new Map<string, (event: never) => void>();
	const posted: FromWorker[] = [];
	const scope: WorkerScope = {
		addEventListener: (type, listener) => {
			listeners.set(type, listener);
		},
		postMessage: (message) => {
			posted.push(message);
		}
	};
	function fire(type: string, event: Partial<FakeEvent> = {}): FakeEvent {
		const full: FakeEvent = { preventDefault: vi.fn(), ...event };
		const listener = listeners.get(type);
		if (listener === undefined) throw new Error('no listener');
		listener(full as never);
		return full;
	}
	return { scope, listeners, posted, fire };
}

beforeEach(() => {
	mocks.createHandler.mockReset();
	mocks.handle.mockReset();
	mocks.handle.mockResolvedValue(undefined);
	mocks.createHandler.mockReturnValue({ handle: mocks.handle });
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe('installWorker', () => {
	it('a message reaches the handler, which posts through the scope', () => {
		const { scope, posted, fire } = fakeScope();
		installWorker(scope);
		expect(mocks.createHandler).toHaveBeenCalledTimes(1);
		const [words, post] = mocks.createHandler.mock.calls[0] as [
			readonly string[],
			(msg: FromWorker) => void
		];
		expect(words).toBe(WORDS_V1);
		post({ type: 'progress', percent: 5 });
		expect(posted).toEqual([{ type: 'progress', percent: 5 }]);

		const data = { op: 'generate' };
		fire('message', { data });
		expect(mocks.handle).toHaveBeenCalledTimes(1);
		expect(mocks.handle).toHaveBeenCalledWith(data);
	});

	it.each(['error', 'unhandledrejection'])(
		'%s is preventDefault-ed and posts WORKER_FAILED with no message text',
		(type) => {
			const { scope, posted, fire } = fakeScope();
			installWorker(scope);
			const event = fire(type, {
				message: 'secret words here',
				reason: new Error('secret words here')
			} as Partial<FakeEvent>);
			expect(event.preventDefault).toHaveBeenCalledTimes(1);
			expect(posted).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
		}
	);

	it('messageerror posts WORKER_FAILED', () => {
		const { scope, posted, fire } = fakeScope();
		installWorker(scope);
		fire('messageerror');
		expect(posted).toEqual([{ type: 'error', code: 'E_WORKER_FAILED' }]);
	});
});

describe('the real-scope call', () => {
	it('does nothing outside a worker scope', async () => {
		vi.resetModules();
		await import('./entry');
		expect(mocks.createHandler).not.toHaveBeenCalled();
	});

	it('installs on the global scope when it is a worker scope', async () => {
		class FakeWorkerScope {
			listeners: string[] = [];
			addEventListener(type: string): void {
				this.listeners.push(type);
			}
			postMessage(): void {}
		}
		const fake = new FakeWorkerScope();
		vi.stubGlobal('WorkerGlobalScope', FakeWorkerScope);
		vi.stubGlobal('self', fake);
		vi.resetModules();
		await import('./entry');
		expect(mocks.createHandler).toHaveBeenCalledTimes(1);
		expect(fake.listeners.sort()).toEqual(
			['error', 'message', 'messageerror', 'unhandledrejection'].sort()
		);
	});
});
