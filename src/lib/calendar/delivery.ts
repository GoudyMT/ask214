/**
 * How the calendar file reaches the user: its name, and the one sentence under the button that says what this
 * device does next. The device is read from the user agent, and whether the app is installed, only to pick that
 * sentence; nothing is stored or sent.
 */
import { localTodayIso } from '../timeline/day-math';
// The same two signals as isInstalled in install-state.ts. Importing that module here would split it out of the
// layout into a chunk of its own, which every page then downloads (measured: +221 B of page chunks).
const isInstalled = () =>
	window.matchMedia('(display-mode: standalone)').matches ||
	(navigator as Navigator & { standalone?: boolean }).standalone === true;
// Chrome, Firefox and Edge on iPhone name themselves in the user agent. Firefox on iPad and Brave send Safari's own,
// so they cannot be told apart and read the Safari sentence.
const OTHER_IOS_BROWSER = /CriOS|FxiOS|EdgiOS/;

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
 * The installed iPhone app, and Chrome, Firefox or Edge on iPhone, keep their data apart from Safari's, so they are
 * never told to go there; they get the steps after the download only. Not yet checked on a real iPhone, and WebKit
 * bug reports (236943, 275288) say an installed app's downloads can fail.
 */
export const IOS_APP_HINT = {
	lead: 'On iPhone or iPad:',
	text: 'it saves a calendar file. Open it from Downloads, then tap Add All.'
};

/** Under every add button: the file stays in the downloads after the calendar takes it, outside Erase all data. */
export const DELETE_FILE_HINT = "Once it's added, you can delete the downloaded file.";

export function deviceHint(
	kind: DeviceKind,
	apartFromSafari: boolean
): { lead: string; text: string } {
	return kind === 'ios' && apartFromSafari ? IOS_APP_HINT : DEVICE_HINT[kind];
}

export function currentDeviceHint(): { lead: string; text: string } {
	const userAgent = navigator.userAgent;
	return deviceHint(
		deviceKind(userAgent, navigator.maxTouchPoints),
		isInstalled() || OTHER_IOS_BROWSER.test(userAgent)
	);
}
