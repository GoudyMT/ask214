import { describe, it, expect, vi } from 'vitest';
import { downloadTextFile } from './download';

describe('downloadTextFile', () => {
	it('creates an anchor with the download name and clicks it, then revokes the URL', () => {
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
		expect(revoke).toHaveBeenCalledOnce();
		vi.restoreAllMocks();
	});
});
