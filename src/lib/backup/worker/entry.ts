import { WORDS_V1 } from '../words-v1';
import { createHandler } from './handler';
import type { FromWorker } from './protocol';

/** The only parts of a worker scope this file touches, so a test can stand in for it. */
export type ScopeEvent = { data?: unknown; preventDefault?: () => void };

export type WorkerScope = {
	addEventListener: (type: string, listener: (event: ScopeEvent) => void) => void;
	postMessage: (message: FromWorker) => void;
};

/**
 * Wires the handler to a worker scope. This is the one file that imports the word list: it is the worker's own copy,
 * so the list never reaches the page's bundle. Every way the scope can fail ends as the same opaque code and never
 * as text, because an error's text could hold a passphrase word.
 */
export function installWorker(scope: WorkerScope): void {
	const { handle } = createHandler(WORDS_V1, (message) => scope.postMessage(message));
	const fail = (event: ScopeEvent): void => {
		event.preventDefault?.();
		scope.postMessage({ type: 'error', code: 'E_WORKER_FAILED' });
	};
	scope.addEventListener('message', (event) => {
		void handle(event.data);
	});
	scope.addEventListener('error', fail);
	scope.addEventListener('unhandledrejection', fail);
	scope.addEventListener('messageerror', fail);
}

// Tests import this file in a page or in Node, where there is no worker scope to wire.
const scopeClass = (globalThis as { WorkerGlobalScope?: abstract new () => object })
	.WorkerGlobalScope;
if (scopeClass !== undefined && self instanceof scopeClass) {
	installWorker(self as unknown as WorkerScope);
}
