import { describe, it, expect, vi } from 'vitest';
import { answerFinderBypass, FINDER_BYPASS } from './finder-bypass-message';
import { workerBypassesFinderData } from './finder-bypass';

type Listener = (event: { data: unknown; ports: MessagePort[] }) => void;

/** A worker in charge of the page that answers the way the given worker code does, through a real MessageChannel. */
function controlledBy(answer: Listener | null): ServiceWorkerContainer {
	const controller = {
		postMessage: vi.fn((data: unknown, transfer: Transferable[]) => {
			answer?.({ data, ports: transfer as MessagePort[] });
		})
	};
	return { controller } as unknown as ServiceWorkerContainer;
}

describe('whether the worker in charge passes SkillBridge files straight to the network', () => {
	// No worker means no cache in the way: the request goes to the network as the page made it.
	it('says yes when no worker is in charge', async () => {
		expect(await workerBypassesFinderData({ controller: null } as ServiceWorkerContainer)).toBe(
			true
		);
		expect(await workerBypassesFinderData(undefined)).toBe(true);
	});

	it('says yes when the worker in charge answers that it does', async () => {
		expect(await workerBypassesFinderData(controlledBy(answerFinderBypass), 200)).toBe(true);
	});

	// A worker from before the bypass ignores the question, and would keep a copy of every file the finder fetched,
	// which narrows where the person is.
	it('says no when the worker in charge does not answer', async () => {
		expect(await workerBypassesFinderData(controlledBy(null), 50)).toBe(false);
	});

	it('says no when the worker cannot be asked', async () => {
		const container = {
			controller: {
				postMessage: () => {
					throw new Error('E_TEST');
				}
			}
		} as unknown as ServiceWorkerContainer;
		expect(await workerBypassesFinderData(container, 50)).toBe(false);
	});

	it.each([
		['another message', { type: 'take-over', build: 'x' }],
		['a bare string', FINDER_BYPASS],
		['nothing', null]
	])('the worker answers nothing to %s', (_name, data) => {
		const { port1, port2 } = new MessageChannel();
		const sent = vi.spyOn(port1, 'postMessage');
		answerFinderBypass({ data, ports: [port1] });
		expect(sent).not.toHaveBeenCalled();
		port1.close();
		port2.close();
	});
});
