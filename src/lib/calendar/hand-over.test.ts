import { describe, it, expect, vi } from 'vitest';
import { handOver } from './hand-over';
import type { CalendarFile } from './build-ics';

const FILE: CalendarFile = {
	ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
	events: [
		{ taskId: 'a', moment: 'last', title: 'Last day: a', isoDate: '2099-01-01', alarmDays: [] }
	]
};
const NOW = new Date(2026, 9, 4, 12);

describe('handOver', () => {
	it('hands the file over first, then records exactly its events', async () => {
		const order: string[] = [];
		const download = vi.fn(() => order.push('download'));
		const recordAdd = vi.fn(async () => {
			order.push('record');
		});
		await handOver(FILE, { locked: false, recordAdd }, NOW, download);
		expect(order).toEqual(['download', 'record']);
		expect(download).toHaveBeenCalledWith(FILE.ics);
		expect(recordAdd).toHaveBeenCalledWith(FILE.events, '2026-10-04', '2026-10-04');
	});

	it('does not throw when the record fails: the file still reached the user', async () => {
		const download = vi.fn();
		const recordAdd = vi.fn(async () => Promise.reject(new Error('E_CALENDAR_RELOCKED')));
		await expect(
			handOver(FILE, { locked: false, recordAdd }, NOW, download)
		).resolves.toBeUndefined();
		expect(download).toHaveBeenCalledOnce();
	});

	// The file is built after the tap and handed over when it is ready. A Lock pressed in between means nothing personal
	// leaves the app after it, so a file finished after the Lock is dropped, unrecorded.
	it('drops the file when the app locked while it was built', async () => {
		const download = vi.fn();
		const recordAdd = vi.fn(async () => {});
		await handOver(FILE, { locked: true, recordAdd }, NOW, download);
		expect(download).not.toHaveBeenCalled();
		expect(recordAdd).not.toHaveBeenCalled();
	});

	it('hands the file over while the app is unlocked', async () => {
		const download = vi.fn();
		await handOver(FILE, { locked: false, recordAdd: vi.fn(async () => {}) }, NOW, download);
		expect(download).toHaveBeenCalledOnce();
	});

	it('still hands the file over when there is no store to record in', async () => {
		const download = vi.fn();
		await handOver(FILE, undefined, NOW, download);
		expect(download).toHaveBeenCalledOnce();
	});
});
