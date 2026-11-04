import { DB_VERSION } from '../db/schema';
import { TAKE_OVER } from './take-over-message';

/**
 * After a release raises the database version, the worker of the release before it stays in charge until every tab
 * closes, and offline it serves its own cached pages, which cannot open the raised database: the person sees "The app
 * couldn't open the information saved on this device" with a Reload that cannot help. So the page that raised it marks
 * the device with its build, and every page of that build asks its own waiting worker to take over at once (the worker
 * obeys only a page of its own build). A page of any other build clears the mark: a release that raised nothing keeps
 * the usual wait, so the open tabs of the release before keep their own worker's files. The mark is a build name:
 * nothing personal. Its key names the database version: a page of the release before, served offline by its own worker,
 * would otherwise clear the mark as another build's, and no later page of this build would ask.
 */
export const RAISED_KEY = `mtc:raised-${DB_VERSION}`;

type MarkStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
// eslint-disable-next-line no-restricted-globals -- a build name, nothing personal (see above)
const device = (): MarkStore => localStorage;

export function markRaised(build: string, store: () => MarkStore = device): void {
	try {
		store().setItem(RAISED_KEY, build);
	} catch {
		// Storage turned off (private mode): the usual wait applies.
	}
}

export async function takeOverIfRaised(
	container: ServiceWorkerContainer,
	build: string,
	store: () => MarkStore = device
): Promise<void> {
	try {
		const mark = store().getItem(RAISED_KEY);
		if (mark === null) return;
		// Another build's mark: that raise was answered, or never can be by this build's worker.
		if (mark !== build) return store().removeItem(RAISED_KEY);
		// The page registers its worker as it starts; ready waits for that, and a raise always has a worker in charge.
		const registration = await container.ready;
		// A new worker in charge: the older pages are gone, and the mark has done its work.
		const clear = () => {
			try {
				store().removeItem(RAISED_KEY);
			} catch {
				// Storage turned off: nothing was kept.
			}
		};
		container.addEventListener('controllerchange', clear, { once: true });
		const ask = (worker: ServiceWorker | null) => worker?.postMessage({ type: TAKE_OVER, build });
		const askOnceInstalled = (worker: ServiceWorker | null) =>
			worker?.addEventListener('statechange', () => {
				if (worker.state === 'installed') ask(worker);
			});
		// The worker may be installing already when the page raises the database, or start installing later.
		askOnceInstalled(registration.installing);
		registration.addEventListener('updatefound', () => askOnceInstalled(registration.installing));
		ask(registration.waiting);
		// WebKit does not look for a new worker on a reload by itself.
		await registration.update();
	} catch {
		// Storage turned off, or no worker: the usual wait applies.
	}
}
