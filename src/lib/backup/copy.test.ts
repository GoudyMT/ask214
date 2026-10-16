import { describe, it, expect } from 'vitest';
import { BACKUP_CODES, type BackupCode } from './codes';
import {
	backupMessage,
	CHECK_NEW_BACKUP_OFFER,
	checkOpensLine,
	COPY_OWED,
	DEVICE_NEWER_WARNING,
	DEVICE_NO_DATA_LINE,
	deviceChangedLine,
	deviceMatchesLine,
	ERASE_DEVICE_BUTTON,
	LOCKED_AFTER_RESTORE_LINE,
	MAKE_NEW_BACKUP_BUTTON,
	NOT_IN_BACKUPS,
	RESTORED_RELOAD_LINE,
	RESTORED_UNLOCK_LINE,
	type MessageContext
} from './copy';
import * as copyModule from './copy';

type Params = Omit<MessageContext, 'path'>;
type Row = { code: BackupCode; params: Params; export: string | null; restore: string | null };

const LABEL = 'Ask 214 backup 2026-10-15 K7QM';
const QUOTE = String.fromCharCode(34);

const NOTHING_CHANGED = 'Nothing on this device was changed.';

// Every string of the wording, repeated here on purpose: a change to a message must change this table too.
const ROWS: Row[] = [
	{
		code: 'E_FILE_TOO_LARGE',
		params: {},
		export: null,
		restore: 'This file is too large to be an Ask 214 backup. Nothing on this device was changed.'
	},
	{
		code: 'E_NOT_BACKUP',
		params: {},
		export: null,
		restore: 'This file is not an Ask 214 backup. Nothing on this device was changed.'
	},
	{
		code: 'E_NEWER_VERSION',
		params: {},
		export: null,
		restore:
			'This backup was made by a newer version of Ask 214. Update the app, then try again. Nothing on this device was changed.'
	},
	{
		code: 'E_DAMAGED',
		params: {},
		export: null,
		restore:
			'This backup file is damaged or was changed. Nothing on this device was changed. If you have another copy of the file, try that one.'
	},
	{
		code: 'E_WRONG_PASSPHRASE',
		params: { label: LABEL },
		export: null,
		restore:
			"These words do not open this backup. Check the word order, and use the passphrase saved under this backup's name: " +
			LABEL +
			'. Nothing on this device was changed.'
	},
	{
		code: 'E_WRONG_PASSPHRASE',
		params: {},
		export: null,
		restore:
			'These words do not open this backup. Check the word order, and check that the passphrase belongs to this backup. Nothing on this device was changed.'
	},
	{
		code: 'E_NO_MEMORY',
		params: {},
		export:
			'This device ran out of memory while making the backup. Close other apps and tabs, then try again. No backup was saved.',
		restore:
			'This device ran out of memory while opening the backup. Your passphrase may be correct. Close other apps and tabs, then try again, or open it on another device, such as a computer.'
	},
	{
		code: 'E_WORKER_FAILED',
		params: {},
		export:
			'The backup step stopped before it finished. Nothing on this device was changed. Try again.',
		restore:
			'The backup step stopped before it finished. Nothing on this device was changed. Try again.'
	},
	{
		code: 'E_CRYPTO_FAILED',
		params: {},
		export: null,
		restore: 'This browser could not open the backup. Nothing on this device was changed.'
	},
	{
		code: 'E_CONTENT_INVALID',
		params: {},
		export: null,
		restore:
			'The backup opened, but part of it cannot be read. Nothing on this device was changed. Keep the file.'
	},
	{
		code: 'E_LOCKED',
		params: {},
		export:
			'Ask 214 locked, so the backup stopped. Nothing on this device was changed. Unlock and start again.',
		restore:
			'Ask 214 locked, so the backup stopped. Nothing on this device was changed. Unlock and start again.'
	},
	{
		code: 'E_CODE_UNAVAILABLE',
		params: {},
		export: 'Backup needs a connection once to download.',
		restore: 'Backup needs a connection once to download.'
	},
	{
		code: 'E_APP_UPDATED',
		params: {},
		export: 'Ask 214 updated. Reload the page, then try again.',
		restore: 'Ask 214 updated. Reload the page, then try again.'
	},
	{
		code: 'E_SNAPSHOT_FAILED',
		params: { store: 'profile' },
		export: 'Could not read your profile to back it up. No backup was saved.',
		restore: null
	},
	{
		code: 'E_SNAPSHOT_FAILED',
		params: { store: 'timeline' },
		export: 'Could not read your timeline to back it up. No backup was saved.',
		restore: null
	},
	{
		code: 'E_SNAPSHOT_FAILED',
		params: { store: 'calendar' },
		export: 'Could not read your calendar settings to back it up. No backup was saved.',
		restore: null
	},
	{
		code: 'E_SAVE_FAILED',
		params: {},
		export: 'The backup was not saved. Try again, or choose another place.',
		restore: null
	},
	{
		code: 'E_WRITE_FAILED',
		params: {},
		export: null,
		restore: 'The restore did not finish. Nothing on this device was changed.'
	},
	{
		code: 'E_CONTENT_TOO_LARGE',
		params: { taskTitle: 'Update my resume' },
		export:
			'Your notes are too long to back up. The longest is on ' +
			QUOTE +
			'Update my resume' +
			QUOTE +
			'. Shorten it, then try again. No backup was saved.',
		restore: null
	},
	{
		code: 'E_EXPORT_SELF_INVALID',
		params: { store: 'profile' },
		export:
			'Ask 214 could not back up your profile: part of it is in a form this version cannot check. No backup was saved. This is a fault in Ask 214, not something you did.',
		restore: null
	},
	{
		code: 'E_EXPORT_SELF_INVALID',
		params: { store: 'calendar' },
		export:
			'Ask 214 could not back up your calendar settings: part of it is in a form this version cannot check. No backup was saved. This is a fault in Ask 214, not something you did.',
		restore: null
	},
	{
		code: 'E_WORD_COUNT',
		params: { numbers: true },
		export: 'Type only the 6 words, without the numbers in front of them.',
		restore: 'Type only the 6 words, without the numbers in front of them.'
	},
	{
		code: 'E_WORD_COUNT',
		params: { numbers: false },
		export: 'Enter all 6 words, with a space between each.',
		restore: 'Enter all 6 words, with a space between each.'
	},
	{
		code: 'E_WORD_COUNT',
		params: {},
		export: 'Enter all 6 words, with a space between each.',
		restore: 'Enter all 6 words, with a space between each.'
	},
	{
		code: 'E_NOT_LETTERS',
		params: { position: 1 },
		export: 'Word 1 has a character that is not a plain letter a to z. Type only the letters.',
		restore: 'Word 1 has a character that is not a plain letter a to z. Type only the letters.'
	},
	{
		code: 'E_NOT_LETTERS',
		params: { position: 6 },
		export: 'Word 6 has a character that is not a plain letter a to z. Type only the letters.',
		restore: 'Word 6 has a character that is not a plain letter a to z. Type only the letters.'
	},
	{
		code: 'E_NOT_A_WORD',
		params: { position: 2 },
		export: 'Word 2 is not one of the backup words. Check its spelling.',
		restore: 'Word 2 is not one of the backup words. Check its spelling.'
	},
	{
		code: 'E_TYPE_BACK_MISMATCH',
		params: { position: 4 },
		export: 'Word 4 does not match the passphrase shown above.',
		restore: 'Word 4 does not match the passphrase shown above.'
	},
	{
		code: 'E_TOOK_TOO_LONG',
		params: {},
		export: 'This took too long, so it stopped. No backup was saved. Try again.',
		restore: 'This took too long, so it stopped. Nothing on this device was changed. Try again.'
	},
	{
		code: 'E_LEFT_APP',
		params: {},
		export:
			'You left Ask 214, so the backup stopped. Nothing was saved. Your passphrase is still here - try again.',
		restore:
			'You left Ask 214, so the backup stopped. Nothing on this device was changed. Your passphrase is still here - try again.'
	},
	{ code: 'E_BACKUP_UNAVAILABLE', params: {}, export: null, restore: null },
	{
		code: 'E_RESTORE_DEVICE_MOVED',
		params: {},
		export: null,
		restore: 'Something on this device changed while you were deciding. Check the details again.'
	},
	{ code: 'E_RESTORE_DEVICE_CHANGED', params: {}, export: null, restore: null },
	{
		code: 'E_RESTORE_DEVICE_DAMAGED',
		params: {},
		export: null,
		restore:
			"Some data saved on this device is damaged, so this backup cannot be restored over it. Nothing on this device was changed. Erase this device's data, then restore."
	},
	{
		code: 'E_RESTORE_CANCELLED',
		params: {},
		export: null,
		restore: 'Stopped. Nothing on this device was changed.'
	},
	{
		code: 'E_LOCKED_ELSEWHERE',
		params: {},
		export:
			'Ask 214 locked in another tab, so the backup stopped. Your passphrase is still here. Unlock, then try again.',
		restore:
			'Ask 214 locked in another tab, so the backup stopped. Nothing on this device was changed. Your passphrase is still here. Unlock, then try again.'
	},
	{ code: 'E_EXPORT_CANCELLED', params: {}, export: 'Stopped. No backup was saved.', restore: null }
];

// Which paths a code can reach in the flows. The input messages show on every path.
const RESTORE_ONLY: BackupCode[] = [
	'E_FILE_TOO_LARGE',
	'E_NOT_BACKUP',
	'E_NEWER_VERSION',
	'E_DAMAGED',
	'E_WRONG_PASSPHRASE',
	'E_CONTENT_INVALID',
	'E_WRITE_FAILED',
	'E_RESTORE_DEVICE_MOVED',
	'E_RESTORE_DEVICE_CHANGED',
	'E_RESTORE_DEVICE_DAMAGED',
	'E_RESTORE_CANCELLED'
];
const EXPORT_ONLY: BackupCode[] = [
	'E_SNAPSHOT_FAILED',
	'E_SAVE_FAILED',
	'E_CONTENT_TOO_LARGE',
	'E_EXPORT_SELF_INVALID',
	'E_EXPORT_CANCELLED'
];

function reachable(code: BackupCode): ('export' | 'restore')[] {
	if (RESTORE_ONLY.includes(code)) return ['restore'];
	if (EXPORT_ONLY.includes(code)) return ['export'];
	return ['export', 'restore'];
}

const FULL: Params = {
	position: 3,
	numbers: false,
	store: 'profile',
	taskTitle: 'Update my resume',
	label: LABEL
};

function messageOrError(code: BackupCode, ctx: MessageContext): string | null | Error {
	try {
		return backupMessage(code, ctx);
	} catch (e) {
		return e instanceof Error ? e : new Error('E_UNKNOWN');
	}
}

// Every distinct string the module can show: each rendered variant, plus every exported string constant.
function allStrings(): string[] {
	const out: string[] = [];
	for (const code of BACKUP_CODES) {
		for (const path of ['export', 'restore', 'check'] as const) {
			for (const numbers of [true, false]) {
				for (const label of [LABEL, undefined]) {
					for (const store of ['profile', 'timeline', 'calendar'] as const) {
						const ctx: MessageContext = { path, position: 2, numbers, store, taskTitle: 'T' };
						if (label !== undefined) ctx.label = label;
						const text = messageOrError(code, ctx);
						if (typeof text === 'string') out.push(text);
					}
				}
			}
		}
	}
	for (const value of Object.values(copyModule)) {
		if (typeof value === 'string') out.push(value);
	}
	// The line builders and the list take the app's own date text, so one sample of each stands for them.
	out.push(deviceMatchesLine('Oct 15, 2026'), deviceChangedLine('date unknown'));
	out.push(checkOpensLine('Oct 15, 2026'), ...NOT_IN_BACKUPS);
	return out;
}

describe('backupMessage wording', () => {
	const cases = ROWS.flatMap((row) =>
		(['export', 'restore', 'check'] as const).map((path) => ({
			code: row.code,
			path,
			params: row.params,
			expected: path === 'export' ? row.export : row.restore
		}))
	);

	it.each(cases)('one fixture per code and path gives the exact string: $code $path', (c) => {
		expect(backupMessage(c.code, { path: c.path, ...c.params })).toBe(c.expected);
	});

	it('the fixture table covers every code', () => {
		expect([...new Set(ROWS.map((r) => r.code))].sort()).toEqual([...BACKUP_CODES].sort());
	});

	it('the three button and offer strings are exact', () => {
		expect(CHECK_NEW_BACKUP_OFFER).toBe(
			"If you no longer have this backup's passphrase, make a new backup now, while this phone still has your data."
		);
		expect(MAKE_NEW_BACKUP_BUTTON).toBe('Make a new backup now');
		expect(ERASE_DEVICE_BUTTON).toBe("Erase this device's data");
	});

	it('the confirm and result lines are exact', () => {
		expect(DEVICE_NO_DATA_LINE).toBe('This device has no saved data yet.');
		expect(DEVICE_NEWER_WARNING).toBe(
			'This device has changes newer than this backup. Restoring replaces them.'
		);
		expect(deviceMatchesLine('Oct 15, 2026')).toBe(
			'This device was last changed when its backup of Oct 15, 2026 was made.'
		);
		expect(deviceChangedLine('Oct 15, 2026')).toBe('This device was last changed Oct 15, 2026.');
		expect(checkOpensLine('Oct 15, 2026')).toBe('This backup opens. Made on Oct 15, 2026.');
		expect(RESTORED_UNLOCK_LINE).toBe('Backup restored. Unlock to see it.');
		expect(RESTORED_RELOAD_LINE).toBe('Backup restored. Reload to see it.');
		expect(LOCKED_AFTER_RESTORE_LINE).toBe(
			'This device was locked after the restore. Unlock to check it.'
		);
		expect(NOT_IN_BACKUPS).toEqual([
			'your API key (kept on this device if one is saved)',
			"Ask's offline library",
			'saved documents',
			"this device's settings (theme, Ask mode)"
		]);
	});

	it('the sentence that says nothing was changed ships only in a text the table pins', () => {
		const pinned = new Set(
			ROWS.flatMap((r) => [r.export, r.restore]).filter((t): t is string => t !== null)
		);
		const carrying = allStrings().filter((s) => s.includes(NOTHING_CHANGED));
		expect(carrying.length).toBeGreaterThan(0);
		for (const s of carrying) expect(pinned.has(s), s).toBe(true);
	});
});

describe('backupMessage coverage', () => {
	it('every BACKUP_CODE has a message on at least one path or is in COPY_OWED', () => {
		for (const code of BACKUP_CODES) {
			const shown =
				backupMessage(code, { path: 'export', ...FULL }) !== null ||
				backupMessage(code, { path: 'restore', ...FULL }) !== null;
			const owed = COPY_OWED.some((o) => o.code === code);
			expect(shown || owed, code).toBe(true);
		}
	});

	it('COPY_OWED lists exactly the pairs that return null for a reachable path', () => {
		const expected: { code: BackupCode; path: string }[] = [];
		for (const code of BACKUP_CODES) {
			for (const path of reachable(code)) {
				if (backupMessage(code, { path, ...FULL }) === null) expected.push({ code, path });
			}
		}
		const key = (o: { code: string; path: string }) => `${o.code}/${o.path}`;
		expect(COPY_OWED.map(key).sort()).toEqual(expected.map(key).sort());
		expect(COPY_OWED.map(key)).toEqual([
			'E_CRYPTO_FAILED/export',
			'E_RESTORE_DEVICE_CHANGED/restore',
			'E_BACKUP_UNAVAILABLE/export',
			'E_BACKUP_UNAVAILABLE/restore'
		]);
	});

	it('COPY_OWED is frozen', () => {
		expect(Object.isFrozen(COPY_OWED)).toBe(true);
	});

	it('the check path gives the restore text for every code', () => {
		for (const code of BACKUP_CODES) {
			expect(backupMessage(code, { path: 'check', ...FULL })).toBe(
				backupMessage(code, { path: 'restore', ...FULL })
			);
		}
	});
});

describe('backupMessage parameters', () => {
	it.each([0, 7, 1.5, NaN, -1, Infinity])('a position of %s throws', (position) => {
		for (const code of ['E_NOT_LETTERS', 'E_NOT_A_WORD', 'E_TYPE_BACK_MISMATCH'] as const) {
			expect(() => backupMessage(code, { path: 'restore', position })).toThrow('E_INTERNAL');
		}
	});

	it('a missing position, store or task title throws', () => {
		expect(() => backupMessage('E_NOT_LETTERS', { path: 'restore' })).toThrow('E_INTERNAL');
		expect(() => backupMessage('E_SNAPSHOT_FAILED', { path: 'export' })).toThrow('E_INTERNAL');
		expect(() => backupMessage('E_EXPORT_SELF_INVALID', { path: 'export' })).toThrow('E_INTERNAL');
		expect(() => backupMessage('E_CONTENT_TOO_LARGE', { path: 'export' })).toThrow('E_INTERNAL');
	});

	it('a store that is not one of the three app stores throws', () => {
		const bad = 'zqxjvstore' as unknown as MessageContext['store'];
		expect(() => backupMessage('E_SNAPSHOT_FAILED', { path: 'export', store: bad })).toThrow(
			'E_INTERNAL'
		);
	});

	it('a code with no text on a path does not demand the parameters for that path', () => {
		expect(backupMessage('E_SNAPSHOT_FAILED', { path: 'restore' })).toBeNull();
		expect(backupMessage('E_CONTENT_TOO_LARGE', { path: 'restore' })).toBeNull();
	});

	it("a label that is not the app's shape renders the no-label text", () => {
		const noLabel = backupMessage('E_WRONG_PASSPHRASE', { path: 'restore' });
		const canary = 'zqxjvone zqxjvtwo zqxjvthree zqxjvfour zqxjvfive zqxjvsix';
		const bad = [
			canary,
			LABEL + ' ' + canary,
			LABEL + '\n',
			'\n' + LABEL,
			LABEL.toLowerCase(),
			'Ask 214 backup 2026-10-15 K7Q',
			'Ask 214 backup 2026-10-15 K7QMX',
			'Ask 214 backup 2026-10-15 k7qm',
			'Ask 214 backup 2026-10-15 0189',
			'Ask 214 backup 26-10-15 K7QM',
			'Ask 214 backup 2026-10-15  K7QM',
			''
		];
		for (const label of bad) {
			const text = backupMessage('E_WRONG_PASSPHRASE', { path: 'restore', label });
			expect(text, JSON.stringify(label)).toBe(noLabel);
			expect(text).not.toContain('zqxjv');
		}
	});

	it("a label in the app's shape is used", () => {
		const text = backupMessage('E_WRONG_PASSPHRASE', { path: 'restore', label: LABEL });
		expect(text).toContain(LABEL);
	});
});

describe('backupMessage safety', () => {
	it('no rendered text holds file or passphrase substrings', () => {
		const labelCanary = 'zqxjvlabel zqxjvwords';
		const titleCanary = 'zqxjvtitle';
		const storeCanary = 'zqxjvstore' as unknown as MessageContext['store'];
		for (const code of BACKUP_CODES) {
			for (const path of ['export', 'restore', 'check'] as const) {
				const ctx: MessageContext = {
					path,
					position: 3,
					numbers: false,
					store: 'profile',
					taskTitle: titleCanary,
					label: labelCanary
				};
				const text = backupMessage(code, ctx);
				if (text === null) continue;
				expect(text, `${code} ${path}`).not.toContain('zqxjvlabel');
				expect(text, `${code} ${path}`).not.toContain('zqxjvwords');
				expect(text.includes(titleCanary), `${code} ${path}`).toBe(
					code === 'E_CONTENT_TOO_LARGE' && path === 'export'
				);
				const withBadStore = messageOrError(code, { ...ctx, store: storeCanary });
				if (typeof withBadStore === 'string') expect(withBadStore).not.toContain('zqxjvstore');
				else if (withBadStore instanceof Error) expect(withBadStore.message).toBe('E_INTERNAL');
			}
		}
	});

	it('a task title appears verbatim, in a pair of straight double quotes', () => {
		const title = 'Plan: a "tricky" title / 100%';
		const text = backupMessage('E_CONTENT_TOO_LARGE', { path: 'export', taskTitle: title });
		expect(text).toContain('The longest is on ' + QUOTE + title + QUOTE + '. Shorten it');
	});

	it("no backup message says 'capital letters' or 'delete'", () => {
		const strings = allStrings();
		expect(strings.length).toBeGreaterThan(40);
		for (const s of strings) {
			expect(s.toLowerCase()).not.toContain('capital letters');
			expect(s.toLowerCase()).not.toContain('delete');
		}
	});

	it('every string is ASCII', () => {
		for (const s of allStrings()) {
			for (let i = 0; i < s.length; i += 1) {
				expect(s.charCodeAt(i), s).toBeLessThan(128);
			}
		}
	});
});
