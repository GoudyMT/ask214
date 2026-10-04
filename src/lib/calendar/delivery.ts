/**
 * How the calendar file reaches the user: its name, and the one sentence under the button that says what this
 * device does next. The device is read from the user agent, and whether the app is installed, only to pick that
 * sentence; nothing is stored or sent.
 */
import { localTodayIso } from '../timeline/day-math';
import { isInstalled } from '../install/install-state';

/** Dated by the local day of the add, so a second add on a later day never meets "file already exists". */
export function calendarFileName(now: Date): string {
	return `ask214-deadlines-${localTodayIso(now)}.ics`;
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
	// Not yet checked on a real iPhone.
	ios: {
		lead: 'On iPhone or iPad, use Safari:',
		text: 'it saves a calendar file. Open it from Downloads, then tap Add All.'
	},
	computer: {
		lead: 'On a computer:',
		text: 'open the downloaded file to add it to Outlook or Apple Calendar. Google Calendar: Settings, then Import.'
	}
};

/**
 * The installed iPhone app keeps its data apart from Safari, so it is never told to go there; it gets the steps
 * after the download only. Not yet checked on a real iPhone.
 */
export const IOS_APP_HINT = {
	lead: 'On iPhone or iPad:',
	text: 'it saves a calendar file. Open it from Downloads, then tap Add All.'
};

export function deviceHint(kind: DeviceKind, installed: boolean): { lead: string; text: string } {
	return kind === 'ios' && installed ? IOS_APP_HINT : DEVICE_HINT[kind];
}

export function currentDeviceHint(): { lead: string; text: string } {
	return deviceHint(deviceKind(navigator.userAgent, navigator.maxTouchPoints), isInstalled());
}
