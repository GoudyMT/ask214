import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BACKUP_MANIFEST, CARRIED_STORES, OPTIONAL_CARRIED_STORES } from '../backup/manifest';
import { ENCRYPTED_STORES } from '../db/registry';

// The app lock's store holds this device's wrong tries and lock counter. A backup carrying it would hand a restored
// device someone else's wait, or let a file reset the wrong tries; and a store list of its own inside the backup code
// (the snapshot, the writer, the device-state reader) would pick it up the day someone adds it there.
const BACKUP_DIR = join(fileURLToPath(new URL('../../', import.meta.url)), 'lib/backup');
const NAME_LITERAL = /['"`]app-lock['"`]/;

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...sourceFiles(path));
		else if (!/\.test\.ts$/.test(entry.name)) out.push(path);
	}
	return out;
}

/** The backup source files, relative to the backup folder, whose text names the store - the manifest excepted. */
function namingTheStore(files: Map<string, string>): string[] {
	return [...files]
		.filter(([name, text]) => name !== 'manifest.ts' && NAME_LITERAL.test(text))
		.map(([name]) => name);
}

// The device-state reader is the restore's own store list and lives outside the backup folder.
const DEVICE_STATE = join(BACKUP_DIR, '../profile/device-state.ts');

function backupFiles(): Map<string, string> {
	return new Map(
		[...sourceFiles(BACKUP_DIR), DEVICE_STATE].map((path) => [
			relative(BACKUP_DIR, path).split(sep).join('/'),
			readFileSync(path, 'utf8')
		])
	);
}

describe('the app lock store and backups', () => {
	it('is never read or written by a backup', () => {
		expect(BACKUP_MANIFEST['app-lock']).toBe('never');
		expect(CARRIED_STORES as readonly string[]).not.toContain('app-lock');
		expect(OPTIONAL_CARRIED_STORES as readonly string[]).not.toContain('app-lock');
	});

	it('is a plain store, not an encrypted one', () => {
		expect(ENCRYPTED_STORES as readonly string[]).not.toContain('app-lock');
	});

	it('is named by no backup source file or the device-state reader, the manifest excepted', () => {
		const files = backupFiles();
		// Control: a scan that read nothing would pass for the wrong reason.
		expect(files.size).toBeGreaterThan(10);
		expect(files.has('manifest.ts')).toBe(true);
		expect(files.has('../profile/device-state.ts')).toBe(true);
		expect(namingTheStore(files)).toEqual([]);
	});

	it('finds the name in a backup file that gains it', () => {
		const files = new Map<string, string>();
		files.set('note-cap.ts', 'export const NOTE_CAP = 4000;');
		files.set('snapshot.ts', `const SNAPSHOT_STORES = ['profile', 'app-lock'];`);
		files.set('restore-writer.ts', 'const WRITTEN = ["app-lock"];');
		expect(namingTheStore(files).sort()).toEqual(['restore-writer.ts', 'snapshot.ts']);
	});
});
