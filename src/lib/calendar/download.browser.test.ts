import { describe, it, expect, vi } from 'vitest';
import { downloadTextFile } from './download';

describe('downloadTextFile', () => {
	it('clicks a download anchor, then frees the blob only after the click tick', () => {
		vi.useFakeTimers();
		const click = vi.fn();
		const created: HTMLAnchorElement[] = [];
		const orig = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
			const el = orig(tag) as HTMLAnchorElement;
			if (tag === 'a') {
				el.click = click;
				created.push(el);
			}
			return el;
		});
		const revoke = vi.spyOn(URL, 'revokeObjectURL');

		downloadTextFile('transition.ics', 'text/calendar', 'BEGIN:VCALENDAR\r\n');

		expect(created[0]?.download).toBe('transition.ics');
		expect(click).toHaveBeenCalledOnce();

		// Revoking on the click's own tick pulls the blob before the browser has finished reading it;
		// Firefox and WebKit then drop the download silently, and this is the feature's only delivery
		// path. The revoke must outlive the handoff.
		expect(revoke).not.toHaveBeenCalled();

		// It must still happen: an object URL that is never revoked pins the user's deadlines in
		// memory for the life of the document.
		vi.runAllTimers();
		expect(revoke).toHaveBeenCalledOnce();

		vi.restoreAllMocks();
		vi.useRealTimers();
	});
});
