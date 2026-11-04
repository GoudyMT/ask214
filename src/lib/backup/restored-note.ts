/**
 * What the Timeline says right after a restore, apart from the rest of the backup wording. The Timeline loads only
 * this, so the whole of `copy.ts` stays with the Backup card instead of becoming a chunk every page that reads one
 * line must also carry. `copy.ts` re-exports these, so the wording is still reviewed there as one list.
 */
export const NOT_IN_BACKUPS_LEAD = 'Not in backups';
export const API_KEY_ITEM = 'your API key';
/** What no backup carries, apart from the API key: the same on every device. */
export const ALWAYS_NOT_IN_BACKUPS: readonly string[] = [
	"Ask's offline library",
	'saved documents',
	"this device's settings (theme, Ask mode)"
];

/**
 * The date is the app's own formatted text, passed in by the caller. The API key is listed only when this device
 * holds none (a restore on the same device keeps it), so the person is not told to set up what is already there.
 */
export const restoredLine = (date: string): string => 'Backup restored (made ' + date + ').';
export const notInBackupsLine = (apiKeyMissing: boolean): string =>
	NOT_IN_BACKUPS_LEAD +
	': ' +
	(apiKeyMissing ? [API_KEY_ITEM, ...ALWAYS_NOT_IN_BACKUPS] : ALWAYS_NOT_IN_BACKUPS).join(', ') +
	'. Set them up again in Settings.';
