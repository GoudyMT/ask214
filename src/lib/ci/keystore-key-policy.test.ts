import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

// Every key the app uses is read through the one seam in src/lib/keystore/ (keysForRow / readKeystoreRow), and the
// keystore record is signed and verified only through signKeystore / verifyKeystore. App code that reaches into a row
// for a key handle, or signs with the raw MAC functions, keeps a path that a later lock mode cannot cover: the keys
// would then still sit in the row in the clear for that code to find.

type SourceFile = { path: string; content: string };
type Violation = { path: string; rule: 'key-handle-read' | 'raw-record-mac' };

const KEY_HANDLE_PATTERNS: RegExp[] = [
	// ks.hmacKeyRef, ks?.dataKeyRef
	/\.\s*(?:hmacKeyRef|dataKeyRef)\b/,
	// ks['hmacKeyRef']
	/\[\s*['"`](?:hmacKeyRef|dataKeyRef)['"`]\s*\]/,
	// const { dataKeyRef } = ks;  (also over several lines)
	/\{[^{}]*\b(?:hmacKeyRef|dataKeyRef)\b[^{}]*\}\s*=(?!=)/,
	// a destructured parameter: ({ dataKeyRef }) => ...
	/\{[^{}]*\b(?:hmacKeyRef|dataKeyRef)\b[^{}]*\}\s*\)\s*=>/
];
// The raw MAC pair: named anywhere (an import, a dynamic import, a property of the module) it is a way around the seam.
const RAW_MAC_PATTERN = /\b(?:computeRecordHmac|verifyRecordHmac)\b/;

/** The rules a file in app code breaks. */
function scanKeystoreKeyUse(files: SourceFile[]): Violation[] {
	const out: Violation[] = [];
	for (const { path, content } of files) {
		if (KEY_HANDLE_PATTERNS.some((p) => p.test(content))) {
			out.push({ path, rule: 'key-handle-read' });
		}
		if (RAW_MAC_PATTERN.test(content)) out.push({ path, rule: 'raw-record-mac' });
	}
	return out;
}

/** Source the policy reads: .ts and .svelte, no test files, and nothing inside the keystore folder, which owns the keys. */
function isAppSource(relPath: string): boolean {
	const path = relPath.split(sep).join('/');
	return (
		/\.(?:ts|svelte)$/.test(path) &&
		!/\.test\.ts$/.test(path) &&
		!path.startsWith('src/lib/keystore/')
	);
}

function findAppSource(root: string, dir: string = root): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
			out.push(...findAppSource(root, full));
		} else if (isAppSource(relative(root, full))) {
			out.push(full);
		}
	}
	return out;
}

describe('keystore key policy: what the scan catches', () => {
	const scan = (content: string) => scanKeystoreKeyUse([{ path: 'src/lib/x.ts', content }]);

	it.each([
		['a property read', 'const k = ks.hmacKeyRef;'],
		['an optional-chain read', 'const k = ks?.dataKeyRef;'],
		['a bracket read', "const k = ks['dataKeyRef'];"],
		['a destructure', 'const { dataKeyRef } = ks;'],
		[
			'a destructure over several lines',
			['const {', '\tv,', '\thmacKeyRef', '} = row;'].join('\n')
		],
		['a destructured parameter', 'const f = ({ hmacKeyRef }) => hmacKeyRef;']
	])('reports %s', (_name, content) => {
		expect(scan(content)).toEqual([{ path: 'src/lib/x.ts', rule: 'key-handle-read' }]);
	});

	it.each([
		['a named import', "import { verifyRecordHmac } from '../keystore/record';"],
		[
			'an import of both',
			"import { computeRecordHmac, verifyRecordHmac } from '#lib/keystore/record';"
		],
		['a dynamic import', "const { computeRecordHmac } = await import('../keystore/record');"]
	])('reports the raw MAC functions in %s', (_name, content) => {
		expect(scan(content).map((v) => v.rule)).toContain('raw-record-mac');
	});

	it('leaves the seam and ordinary key words alone', () => {
		expect(scan("import { signKeystore, verifyKeystore } from '../keystore/record';")).toEqual([]);
		expect(scan('const { row, keys } = await readKeystoreRow(db);')).toEqual([]);
		expect(scan('encryptRecord(ctx, bytes, keyIdentity(row), keys.dataKey, 1);')).toEqual([]);
		expect(scan('const hmacKey = keys.hmacKey;')).toEqual([]);
		expect(scan('const row = { id: 0, other: dataKeyRefs.length };')).toEqual([]);
	});

	it('does not read the keystore folder or a test file as app code', () => {
		expect(isAppSource('src/lib/keystore/read.ts')).toBe(false);
		expect(isAppSource(['src', 'lib', 'keystore', 'bootstrap.ts'].join(sep))).toBe(false);
		expect(isAppSource('src/lib/profile/store.svelte.test.ts')).toBe(false);
		expect(isAppSource('src/lib/profile/store.browser.test.ts')).toBe(false);
		expect(isAppSource('src/lib/backup/BackupCard.svelte.test.ts')).toBe(false);
		expect(isAppSource('src/lib/profile/store.svelte.ts')).toBe(true);
		expect(isAppSource('src/lib/components/Panel.svelte')).toBe(true);
	});

	it('walks into folders but skips dot folders and node_modules', () => {
		const root = mkdtempSync(join(tmpdir(), 'key-policy-'));
		try {
			for (const rel of [
				join('src', 'lib', 'a.ts'),
				join('src', 'lib', 'keystore', 'b.ts'),
				join('src', 'lib', 'c.test.ts'),
				join('src', 'routes', 'Page.svelte'),
				join('.wrangler', 'd.ts'),
				join('node_modules', 'e.ts')
			]) {
				mkdirSync(dirname(join(root, rel)), { recursive: true });
				writeFileSync(join(root, rel), '');
			}
			expect(
				findAppSource(root)
					.map((p) => relative(root, p).split(sep).join('/'))
					.sort()
			).toEqual(['src/lib/a.ts', 'src/routes/Page.svelte']);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('keystore key policy: the real tree', () => {
	it('app code reads no key handle from a row and never names the raw MAC functions', () => {
		const root = process.cwd();
		const paths = findAppSource(root, join(root, 'src'));
		// A scan that found nothing to read would pass for the wrong reason.
		expect(paths.length).toBeGreaterThan(0);
		const files = paths.map((path) => ({
			path: relative(root, path),
			content: readFileSync(path, 'utf8')
		}));
		expect(scanKeystoreKeyUse(files)).toEqual([]);
	});
});
