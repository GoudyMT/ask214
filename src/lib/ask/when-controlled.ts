/**
 * Wait until a service worker controls this page, so the next download goes through it and is kept.
 *
 * On a first visit the worker installs after the page has loaded, and a request made before it takes charge goes
 * straight to the network: nothing keeps it, and the model, the runtime and the answer library are downloaded
 * again next time. Waiting for the worker before the first of them costs nothing once it is in charge, and a few
 * seconds while it installs.
 *
 * @param timeoutMs How long to wait for a worker still installing; past it the download goes ahead, not kept.
 * @param container The page's `navigator.serviceWorker`; undefined where the browser has none.
 * @returns true once a worker controls the page; false where there is none, or when the time runs out.
 */
export function whenControlled(
	timeoutMs: number,
	container: ServiceWorkerContainer | undefined
): Promise<boolean> {
	if (container === undefined) return Promise.resolve(false);
	if (container.controller !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const onChange = () => end(true);
		const timer = setTimeout(() => end(false), timeoutMs);
		function end(controlled: boolean) {
			clearTimeout(timer);
			container?.removeEventListener('controllerchange', onChange);
			resolve(controlled);
		}
		container.addEventListener('controllerchange', onChange);
		// A worker that has finished activating and still does not control this page never will - it claims pages
		// only while it activates, and a hard reload bypasses it - so waiting the full time would buy nothing.
		void container.getRegistration().then(
			(registration) => {
				const settled = registration?.active?.state === 'activated';
				const pending = registration?.installing || registration?.waiting;
				if (settled && !pending) end(false);
			},
			() => {}
		);
	});
}
