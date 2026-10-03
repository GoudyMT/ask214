/**
 * How the calendar file reaches the user: its name, and the one sentence under the button that says what this
 * device does next. The device is read from the user agent only to pick that sentence; nothing is stored or sent.
 */

/** Dated by the day of the add, so a second add on a later day never meets "file already exists". */
export function calendarFileName(now: Date): string {
	return `ask214-deadlines-${now.toISOString().slice(0, 10)}.ics`;
}

export type DeviceKind = 'android' | 'ios' | 'computer';

export function deviceKind(userAgent: string, maxTouchPoints: number): DeviceKind {
	if (/Android/i.test(userAgent)) return 'android';
	// iPadOS requests desktop pages with a Mac user agent; a Mac reports no touch points.
	if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1))
		return 'ios';
	return 'computer';
}

/** The sentence under the button: what the browser and the device do after the tap. */
export const DEVICE_HINT: Record<DeviceKind, { lead: string; text: string }> = {
	android: {
		lead: 'On this phone:',
		text: 'it saves a calendar file, then asks which app to open it with. Pick your calendar, then tap Add all.'
	},
	// Not yet checked on a real iPhone: installed home-screen apps are reported to refuse this download.
	ios: {
		lead: 'On iPhone or iPad, use Safari:',
		text: 'it saves a calendar file. Open it from Downloads, then tap Add All.'
	},
	computer: {
		lead: 'On a computer:',
		text: 'open the downloaded file to add it to Outlook or Apple Calendar. Google Calendar: Settings, then Import.'
	}
};

export function currentDeviceHint(): { lead: string; text: string } {
	return DEVICE_HINT[deviceKind(navigator.userAgent, navigator.maxTouchPoints)];
}
