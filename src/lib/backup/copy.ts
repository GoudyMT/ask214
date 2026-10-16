import type { BackupCode } from './codes';

/**
 * Every message the backup flows can show, in this one module, so the wording is reviewed in one place. The wording
 * is DRAFT, written for the owner's review.
 *
 * A message never repeats a word of the passphrase or a byte of the file, and an error's own text is never shown. The
 * only variable parts are the parameters of MessageContext, each checked or looked up here: a position is an integer
 * from 1 to 6, a store is one of three app words, the task title is app text the caller looks up, and a label is used
 * only when it has the shape the app itself gives a backup.
 *
 * The sentence "Nothing on this device was changed" ships only where a test proves the stored rows byte-identical
 * after that failure; the flow code that adds such a failure owes that test.
 */
export type MessageContext = {
	path: 'export' | 'restore' | 'check';
	position?: number;
	numbers?: boolean;
	store?: 'profile' | 'timeline' | 'calendar';
	taskTitle?: string;
	label?: string;
};

/** Offered beside the wrong-passphrase message when the person may have lost the passphrase. */
export const CHECK_NEW_BACKUP_OFFER =
	"If you no longer have this backup's passphrase, make a new backup now, while this phone still has your data.";
export const MAKE_NEW_BACKUP_BUTTON = 'Make a new backup now';
/** The button beside the "device is damaged" restore message. */
export const ERASE_DEVICE_BUTTON = "Erase this device's data";

/**
 * What the restore confirm and the result lines say about the device and the outcome. The dates are the app's own
 * formatted text, passed in by the caller.
 */
export const DEVICE_NO_DATA_LINE = 'This device has no saved data yet.';
export const DEVICE_NEWER_WARNING =
	'This device has changes newer than this backup. Restoring replaces them.';
export const RESTORED_UNLOCK_LINE = 'Backup restored. Unlock to see it.';
export const RESTORED_RELOAD_LINE = 'Backup restored. Reload to see it.';
export const LOCKED_AFTER_RESTORE_LINE =
	'This device was locked after the restore. Unlock to check it.';
export const deviceMatchesLine = (date: string): string =>
	'This device was last changed when its backup of ' + date + ' was made.';
export const deviceChangedLine = (date: string): string =>
	'This device was last changed ' + date + '.';
export const checkOpensLine = (date: string): string => 'This backup opens. Made on ' + date + '.';

/** What no backup carries. Static: the confirm shows every item whatever this device holds. */
export const NOT_IN_BACKUPS: readonly string[] = Object.freeze([
	'your API key (kept on this device if one is saved)',
	"Ask's offline library",
	'saved documents',
	"this device's settings (theme, Ask mode)"
]);

type TextPath = 'export' | 'restore';

/**
 * The pairs that return null for a path the code can reach: no text is written for them yet. Listed in one place so
 * the wording review finds them.
 */
export const COPY_OWED: readonly Readonly<{ code: BackupCode; path: TextPath }>[] = Object.freeze([
	Object.freeze({ code: 'E_CRYPTO_FAILED', path: 'export' } as const),
	Object.freeze({ code: 'E_RESTORE_DEVICE_CHANGED', path: 'restore' } as const),
	Object.freeze({ code: 'E_BACKUP_UNAVAILABLE', path: 'export' } as const),
	Object.freeze({ code: 'E_BACKUP_UNAVAILABLE', path: 'restore' } as const)
]);

// The shape of the label the app gives a backup: a date and four base32 characters (A-Z and 2-7). Anything else
// could be a pasted passphrase, so it is never printed.
const LABEL_SHAPE = /^Ask 214 backup [0-9]{4}-[0-9]{2}-[0-9]{2} [A-Z2-7]{4}$/;

function bad(): never {
	throw new Error('E_INTERNAL');
}

function wordNumber(position: number | undefined): number {
	if (position === undefined || !Number.isInteger(position) || position < 1 || position > 6) {
		return bad();
	}
	return position;
}

function storeWords(store: MessageContext['store']): string {
	switch (store) {
		case 'profile':
			return 'profile';
		case 'timeline':
			return 'timeline';
		case 'calendar':
			return 'calendar settings';
		default:
			return bad();
	}
}

function onRestore(path: TextPath, text: string): string | null {
	return path === 'restore' ? text : null;
}

function onExport(path: TextPath, text: string): string | null {
	return path === 'export' ? text : null;
}

/**
 * The message for a code on a path, or null when the code has no text there. The check path uses the restore text.
 * A parameter that a code needs and the caller left out, or got wrong, throws E_INTERNAL: it is a bug in the caller.
 */
export function backupMessage(code: BackupCode, ctx: MessageContext): string | null {
	const path: TextPath = ctx.path === 'export' ? 'export' : 'restore';
	switch (code) {
		case 'E_FILE_TOO_LARGE':
			return onRestore(
				path,
				'This file is too large to be an Ask 214 backup. Nothing on this device was changed.'
			);
		case 'E_NOT_BACKUP':
			return onRestore(
				path,
				'This file is not an Ask 214 backup. Nothing on this device was changed.'
			);
		case 'E_NEWER_VERSION':
			return onRestore(
				path,
				'This backup was made by a newer version of Ask 214. Update the app, then try again. Nothing on this device was changed.'
			);
		case 'E_DAMAGED':
			return onRestore(
				path,
				'This backup file is damaged or was changed. Nothing on this device was changed. If you have another copy of the file, try that one.'
			);
		case 'E_WRONG_PASSPHRASE':
			if (path !== 'restore') return null;
			if (ctx.label !== undefined && LABEL_SHAPE.test(ctx.label)) {
				return (
					"These words do not open this backup. Check the word order, and use the passphrase saved under this backup's name: " +
					ctx.label +
					'. Nothing on this device was changed.'
				);
			}
			return 'These words do not open this backup. Check the word order, and check that the passphrase belongs to this backup. Nothing on this device was changed.';
		case 'E_NO_MEMORY':
			return path === 'restore'
				? 'This device ran out of memory while opening the backup. Your passphrase may be correct. Close other apps and tabs, then try again, or open it on another device, such as a computer.'
				: 'This device ran out of memory while making the backup. Close other apps and tabs, then try again. No backup was saved.';
		case 'E_WORKER_FAILED':
			return 'The backup step stopped before it finished. Nothing on this device was changed. Try again.';
		case 'E_CRYPTO_FAILED':
			return onRestore(
				path,
				'This browser could not open the backup. Nothing on this device was changed.'
			);
		case 'E_CONTENT_INVALID':
			return onRestore(
				path,
				'The backup opened, but part of it cannot be read. Nothing on this device was changed. Keep the file.'
			);
		case 'E_LOCKED':
			return 'Ask 214 locked, so the backup stopped. Nothing on this device was changed. Unlock and start again.';
		case 'E_CODE_UNAVAILABLE':
			return 'Backup needs a connection once to download.';
		case 'E_APP_UPDATED':
			return 'Ask 214 updated. Reload the page, then try again.';
		case 'E_SNAPSHOT_FAILED':
			if (path !== 'export') return null;
			return (
				'Could not read your ' + storeWords(ctx.store) + ' to back it up. No backup was saved.'
			);
		case 'E_SAVE_FAILED':
			return onExport(path, 'The backup was not saved. Try again, or choose another place.');
		case 'E_WRITE_FAILED':
			return onRestore(path, 'The restore did not finish. Nothing on this device was changed.');
		case 'E_CONTENT_TOO_LARGE':
			if (path !== 'export') return null;
			if (ctx.taskTitle === undefined) return bad();
			return (
				'Your notes are too long to back up. The longest is on "' +
				ctx.taskTitle +
				'". Shorten it, then try again. No backup was saved.'
			);
		case 'E_EXPORT_SELF_INVALID':
			if (path !== 'export') return null;
			return (
				'Ask 214 could not back up your ' +
				storeWords(ctx.store) +
				': part of it is in a form this version cannot check. No backup was saved. This is a fault in Ask 214, not something you did.'
			);
		case 'E_WORD_COUNT':
			return ctx.numbers === true
				? 'Type only the 6 words, without the numbers in front of them.'
				: 'Enter all 6 words, with a space between each.';
		case 'E_NOT_LETTERS':
			return (
				'Word ' +
				wordNumber(ctx.position) +
				' has a character that is not a plain letter a to z. Type only the letters.'
			);
		case 'E_NOT_A_WORD':
			return (
				'Word ' + wordNumber(ctx.position) + ' is not one of the backup words. Check its spelling.'
			);
		case 'E_TYPE_BACK_MISMATCH':
			return 'Word ' + wordNumber(ctx.position) + ' does not match the passphrase shown above.';
		case 'E_TOOK_TOO_LONG':
			return path === 'restore'
				? 'This took too long, so it stopped. Nothing on this device was changed. Try again.'
				: 'This took too long, so it stopped. No backup was saved. Try again.';
		case 'E_LEFT_APP':
			return path === 'restore'
				? 'You left Ask 214, so the backup stopped. Nothing on this device was changed. Your passphrase is still here - try again.'
				: 'You left Ask 214, so the backup stopped. Nothing was saved. Your passphrase is still here - try again.';
		case 'E_RESTORE_DEVICE_MOVED':
			return onRestore(
				path,
				'Something on this device changed while you were deciding. Check the details again.'
			);
		case 'E_RESTORE_DEVICE_DAMAGED':
			return onRestore(
				path,
				"Some data saved on this device is damaged, so this backup cannot be restored over it. Nothing on this device was changed. Erase this device's data, then restore."
			);
		case 'E_LOCKED_ELSEWHERE':
			return path === 'restore'
				? 'Ask 214 locked in another tab, so the backup stopped. Nothing on this device was changed. Your passphrase is still here. Unlock, then try again.'
				: 'Ask 214 locked in another tab, so the backup stopped. Your passphrase is still here. Unlock, then try again.';
		case 'E_RESTORE_CANCELLED':
			return onRestore(path, 'Stopped. Nothing on this device was changed.');
		case 'E_EXPORT_CANCELLED':
			return onExport(path, 'Stopped. No backup was saved.');
		case 'E_RESTORE_DEVICE_CHANGED':
		case 'E_BACKUP_UNAVAILABLE':
			return null;
		default:
			return bad();
	}
}
