import { isDay } from '../timeline/day-check';
import { localTodayIso } from '../timeline/day-math';

/**
 * The file name and the on-screen "Backup name" of a backup.
 *
 * Both carry the local calendar DATE and a short random id, and never a time of day: a local time beside a cloud
 * drive's own upload time would give away the person's time zone. The id keeps two backups made on one day apart,
 * so a password manager files each passphrase under its own file's name. Both strings are built from one
 * (date, id) pair, so they always match.
 */

// RFC 4648 base32: no 0, 1, 8 or 9, which are easy to misread.
export const BACKUP_ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const ID_LENGTH = 4;
const ID_SHAPE = /^[A-Z2-7]{4}$/;
const FILE_NAME_SHAPE = /^ask214-backup-(\d{4}-\d{2}-\d{2})-([A-Z2-7]{4})\.json$/;

/** Four random characters. 256 is a multiple of 32, so masking a byte to 5 bits is exactly uniform. */
export function makeBackupId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
	let id = '';
	for (const byte of bytes) {
		id += BACKUP_ID_ALPHABET.charAt(byte & 31);
	}
	return id;
}

export function makeBackupNames(now: Date, id: string): { fileName: string; label: string } {
	if (!ID_SHAPE.test(id)) throw new Error('E_INTERNAL');
	const date = localTodayIso(now);
	return {
		fileName: 'ask214-backup-' + date + '-' + id + '.json',
		label: 'Ask 214 backup ' + date + ' ' + id
	};
}

/**
 * The label for a chosen file, or null when its name is not exactly the one the app gave it (a renamed file, a
 * download that added "(1)"). A file name is only a hint, so nothing but the date and the id is ever returned.
 */
export function parseBackupLabel(fileName: string): string | null {
	const match = FILE_NAME_SHAPE.exec(fileName);
	if (match === null || !isDay(match[1])) return null;
	return 'Ask 214 backup ' + match[1] + ' ' + match[2];
}
