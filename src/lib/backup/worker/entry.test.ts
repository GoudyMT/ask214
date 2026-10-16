import { readFileSync } from 'node:fs';
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

	it('listens for exactly message, messageerror, error and unhandledrejection', () => {
		const { scope, listeners } = fakeScope();
		installWorker(scope);
		expect([...listeners.keys()].sort()).toEqual(
			['error', 'message', 'messageerror', 'unhandledrejection'].sort()
		);
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

describe('the entry file imports', () => {
	const entrySource = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');

	function importsOf(source: string): string[] {
		return [...source.matchAll(/(?:from|import)\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
	}

	it('imports words-v1 and not kdf-paths', () => {
		const specifiers = importsOf(entrySource);
		expect(specifiers).toContain('../words-v1');
		expect(specifiers.some((s) => s.includes('kdf-paths'))).toBe(false);
	});

	it('reaches nothing from routes, components or a Svelte file, in itself or its local imports', () => {
		const seen = new Set<string>();
		const queue = ['./entry.ts'];
		const base = new URL('./', import.meta.url);
		while (queue.length > 0) {
			const file = queue.pop() ?? '';
			if (seen.has(file)) continue;
			seen.add(file);
			const url = new URL(file, base);
			const source = readFileSync(url, 'utf8');
			for (const specifier of importsOf(source)) {
				expect(specifier).not.toMatch(/routes|components|\.svelte|kdf-paths|\$app|\$lib/);
				if (specifier.startsWith('.')) {
					const resolved = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url);
					queue.push(resolved.href);
				}
			}
		}
		expect(seen.size).toBeGreaterThan(1);
	});
});
