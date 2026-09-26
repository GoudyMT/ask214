import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { LOCAL_DOCUMENTS } from '$lib/sources/local-documents.data';
import { LOCAL_DOCUMENT_INFO } from '$lib/sources/local-document-info.data';

// The served documents are proven against their captures only on the machine that holds the captures, and
// the captures never reach CI. So publishing writes a manifest of what it proved - each served file's hash,
// size, page count and a digest of its text layer - and CI holds the committed files to it. Without this,
// a document swapped by a hand copy, a merge or a re-publish would pass every check that runs here. This
// file checks the bytes; `check:sources-index` re-extracts the text layers and scans for active content,
// and the highlight gate measures that citations land on real pages.

type ManifestEntry = {
	sourceId: string;
	file: string;
	sha256: string;
	bytes: number;
	pages: number;
	keptImages: number;
	keptPerPage: Record<string, number>;
	darkenedPages: number[];
};

type WorkflowStep = { name?: string; run?: string; if?: string; 'continue-on-error'?: boolean };

const DOCS_DIR = join(process.cwd(), 'static/docs');
const MANIFEST = join(process.cwd(), 'content-ops/served-pdfs.json');

/** The committed manifest, or no entries when it is absent - the first test reports that on its own. */
function readManifest(): ManifestEntry[] {
	return existsSync(MANIFEST)
		? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestEntry[])
		: [];
}

describe('served documents manifest', () => {
	const entries = readManifest();

	it('is committed beside the pipeline that writes it', () => {
		expect(existsSync(MANIFEST)).toBe(true);
	});

	// Hashing the real files is the point: a size or a name can survive a swap, a SHA-256 cannot.
	it('records every served file by its hash and size, and nothing that is not served', () => {
		const onDisk = readdirSync(DOCS_DIR)
			.sort()
			.map((file) => {
				const bytes = readFileSync(join(DOCS_DIR, file));
				return {
					file,
					sha256: createHash('sha256').update(bytes).digest('hex'),
					bytes: bytes.length
				};
			});
		const recorded = entries
			.map(({ file, sha256, bytes }) => ({ file, sha256, bytes }))
			.sort((a, b) => (a.file < b.file ? -1 : 1));
		expect(recorded).toEqual(onDisk);
	});

	it('names exactly the documents the app serves, under the paths it resolves', () => {
		expect(Object.fromEntries(entries.map((e) => [e.sourceId, `/docs/${e.file}`]))).toEqual(
			LOCAL_DOCUMENTS
		);
	});

	it('records the page count the app states for each document', () => {
		const statedPages = Object.fromEntries(
			Object.entries(LOCAL_DOCUMENT_INFO).map(([sourceId, info]) => [sourceId, info.pages])
		);
		expect(Object.fromEntries(entries.map((e) => [e.sourceId, e.pages]))).toEqual(statedPages);
	});

	// A fixed order means a re-publish diffs only the documents that changed.
	it('lists the documents in source id order', () => {
		const ids = entries.map((e) => e.sourceId);
		expect(ids).toEqual([...ids].sort());
	});
});

// Every picture not marked Public Domain is removed, and one pixel is drawn over its area in its place. The pixel
// is light grey (#e9ecef), so a removed picture reads as "a picture was here", not as a blank or broken page -
// or mid grey (#767676) where the page sets light text on the picture, so that text stays readable. It is read
// from the committed files, so a derivation that changed either colour is caught here, where CI runs.
const REMOVED =
	/\/Subtype \/Image\s*\/Width 1\s*\/Height 1\s*\/ColorSpace \/DeviceRGB\s*\/BitsPerComponent 8\s*\/Length 3\s*>>\s*stream\r?\n([\s\S]{3})/g;

// A stream object's dictionary, up to the keyword that starts its data. The files hold no object or
// cross-reference streams (`check:sources-index` refuses both), so every dictionary is in the raw bytes.
const STREAM_DICTIONARY = /^\s*\d+ 0 obj\s*<<([\s\S]*?)>>\s*stream\r?\n/;

// Split at each object's end first, so a search for one dictionary never runs on into the objects after it.
const streamDictionaries = (text: string) =>
	text
		.split('endobj')
		.map((object) => STREAM_DICTIONARY.exec(object)?.[1])
		.filter((dictionary): dictionary is string => dictionary !== undefined);

const committed = () =>
	readdirSync(DOCS_DIR).map((file) => ({
		file,
		text: readFileSync(join(DOCS_DIR, file)).toString('latin1')
	}));

describe('removed pictures', () => {
	it('are each drawn as one grey pixel, light or mid', () => {
		const colours = new Set<string>();
		for (const { text } of committed()) {
			for (const match of text.matchAll(REMOVED)) {
				colours.add(Buffer.from(match[1] as string, 'latin1').toString('hex'));
			}
		}
		expect([...colours].sort()).toEqual(['767676', 'e9ecef']);
	});

	// A page thumbnail is a small picture of the whole page, photographs included, and carries no image subtype.
	it('leave no page thumbnail behind', () => {
		expect(
			committed()
				.filter(({ text }) => /\/Thumb[\s/<>[\]()]/.test(text))
				.map(({ file }) => file)
		).toEqual([]);
	});

	// A picture is any stream with a width and a height. Each one is the one-pixel blank or a kept Public Domain
	// picture, re-encoded as JPEG - and the kept ones are exactly as many as the manifest records, so a picture
	// added to a served file after publishing fails here even though the file's text is unchanged.
	it('leave only the blanks and the kept Public Domain pictures the manifest counts', () => {
		const kept = Object.fromEntries(readManifest().map((e) => [e.file, e.keptImages]));
		const census = committed().map(({ file, text }) => {
			const pictures = streamDictionaries(text).filter(
				(d) => /\/Width\s/.test(d) && /\/Height\s/.test(d)
			);
			const blank = (d: string) =>
				/\/Width 1\s/.test(d) && /\/Height 1\s/.test(d) && /\/Length 3\b/.test(d);
			const others = pictures.filter((d) => !blank(d));
			return { file, kept: others.length, jpeg: others.every((d) => /\/DCTDecode\b/.test(d)) };
		});
		expect(census).toEqual(census.map(({ file }) => ({ file, kept: kept[file], jpeg: true })));
		expect(census.reduce((sum, c) => sum + c.kept, 0)).toBeGreaterThan(0);
	});

	// The manifest lists the kept pictures and the mid-grey pages by page, so a recapture that changes either
	// shows in its pull request as pages to look at. What it lists must be what the files hold.
	it('are drawn mid grey in exactly the files whose manifest entry lists mid-grey pages', () => {
		const listed = Object.fromEntries(
			readManifest().map((e) => [e.file, e.darkenedPages.length > 0])
		);
		const drawn = Object.fromEntries(
			committed().map(({ file, text }) => [
				file,
				[...text.matchAll(REMOVED)].some(
					(m) => Buffer.from(m[1] as string, 'latin1').toString('hex') === '767676'
				)
			])
		);
		expect(drawn).toEqual(listed);
		expect(Object.values(listed).some(Boolean)).toBe(true);
	});

	it('are counted by page in the manifest, adding up to each file kept total', () => {
		for (const entry of readManifest()) {
			const byPage = Object.values(entry.keptPerPage).reduce((sum, n) => sum + n, 0);
			expect({ file: entry.file, byPage }).toEqual({ file: entry.file, byPage: entry.keptImages });
		}
	});
});

describe('served documents CI gates', () => {
	const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
	const workflow = parse(readFileSync(join(process.cwd(), '.github/workflows/ci.yml'), 'utf8'));
	const steps: WorkflowStep[] = workflow.jobs?.test?.steps ?? [];
	const runs = (step: WorkflowStep, script: string) =>
		typeof step.run === 'string' && step.run.includes(script);

	it('defines the highlight gate script', () => {
		expect(pkg.scripts['highlight-gate']).toContain('content-ops/highlight-gate.mjs');
	});

	// The gate reads the corpus from the build output, so it can only run once the build has produced it.
	it('runs the highlight gate unconditionally, after the build', () => {
		const build = steps.findIndex((s) => s.run === 'pnpm run build');
		const gate = steps.findIndex((s) => runs(s, 'highlight-gate'));
		expect(build).toBeGreaterThanOrEqual(0);
		expect(gate).toBeGreaterThan(build);
		expect(steps[gate]?.if).toBeUndefined();
		expect(steps[gate]?.['continue-on-error']).toBeUndefined();
	});

	// A gate that names its corpus file by hand keeps measuring the old one when a rebuild leaves it behind.
	it('measures the corpus the app loads, not a file named by hand', () => {
		for (const gate of ['content-ops/highlight-gate.mjs', 'content-ops/answer-gate.mjs']) {
			const source = readFileSync(join(process.cwd(), gate), 'utf8');
			expect({ gate, hardCoded: /corpus-v\d/.test(source) }).toEqual({ gate, hardCoded: false });
			expect({ gate, readsBase: source.includes('CORPUS_BASE') }).toEqual({
				gate,
				readsBase: true
			});
		}
	});

	it('runs the sources-index check, which re-extracts the text layers and scans for active content', () => {
		expect(steps.some((s) => runs(s, 'check:sources-index'))).toBe(true);
	});

	// A pull request publishes every commit it carries. The check walks them all, so the checkout must fetch the
	// whole history - a shallow one would hold only the head and pass without looking.
	it('checks every served file the pull request carries, over the whole history', () => {
		expect(pkg.scripts['check:served-history']).toContain('content-ops/check-served-history.mjs');
		const step = steps.find((s) => runs(s, 'check:served-history'));
		expect(step).toBeDefined();
		expect(step?.if).toBeUndefined();
		expect(step?.['continue-on-error']).toBeUndefined();
		const checkout = (workflow.jobs?.test?.steps ?? []).find((s: { uses?: string }) =>
			s.uses?.startsWith('actions/checkout@')
		);
		expect(checkout?.with?.['fetch-depth']).toBe(0);
	});
});
