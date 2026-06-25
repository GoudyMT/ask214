// content-ops/capture-extract.mjs
// Run from the repo root: `pnpm ingest` (= tsx content-ops/capture-extract.mjs).
//
// A2 build-time INGEST ENGINE (capture + extract + fidelity). PRODUCER-SIDE / BUILD-TIME ONLY: this never
// runs on a user device or a live server. It produces the static, content-addressed corpus that ships to
// users, who only download + read it offline (ADR-018, local-first). A5 (Refresh) will later wrap this same
// engine in a scheduler - the engine is not rebuilt, just automated.
//
// Build-only: pdfjs-dist + child_process(pdftotext) + yaml run HERE, never in a src/ runtime module (the
// no-third-party-runtime-JS rule; mirrors validate-sources.mjs). The complexity lives in tested pure units
// under src/lib/content-ops/; this script only does the IO + the library calls.
//
// INCREMENT 1 (this stage): PDF sources only - capture (sha256 + content-addressed audit copy) + extract
// (pdfjs) + the A2-D6 fidelity cross-check (pdfjs vs the independent pdftotext) + the full similarity
// distribution, so the threshold is locked on real data. HTML + the 4 fetch-blocked + the sources.yaml
// backfill are the next increments.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { parse } from 'yaml';
// legacy = the Node build; the default build constructs `new DOMMatrix()` (a browser global) at load.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { auditCopyRecord } from '../src/lib/content-ops/capture/audit-copy.ts';
import { assemblePdfText } from '../src/lib/content-ops/extract/pdf-text.ts';
import { trigramSimilarity } from '../src/lib/content-ops/extract/similarity.ts';
import { checkExtractionSanity } from '../src/lib/content-ops/extract/fidelity.ts';
import { normalizeText } from '../src/lib/corpus/normalize.ts';

// Config - resolved, never machine-hardcoded (env override wins; sensible repo-relative defaults).
const SOURCES_YAML = 'content/sources.yaml';
const STAGING_DIR = process.env.TAP_PDF_DIR ?? 'content-ops/staged'; // where the byte-exact TAP originals sit
const CAPTURES_DIR = 'content-ops/captures'; // content-addressed audit copies (A2-D5; never served)
const EXTRACTED_DIR = 'content-ops/extracted'; // per-source extractor output (A3 input)

// A2-D6 threshold, LOCKED from the full 21-doc distribution (S31): the clean cluster floor is 0.8597 and the
// highest flagged is 0.7457, so 0.80 sits centered in that gap - passes all 18 clean docs with margin, flags
// the 3 most structurally-complex (TOC/columnar/interactive) for human review. Below it = flagged, never
// silently shipped. The metric is order-sensitive by design (it scores layout divergence, not just
// corruption) - the safe bias for a fidelity gate; a v2.x refinement could add auto-escalation (spec-deferred).
const FIDELITY_THRESHOLD = 0.8;

/** Resolve pdftotext to a full path: Node's execFileSync does NOT apply Windows PATHEXT to a bare name, so a
 *  plain 'pdftotext' ENOENTs even when on PATH. Env override wins; else scan PATH (+ PATHEXT on win). */
function resolvePdftotext() {
	const name = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
	// 1. Explicit override (the portable escape hatch; also what CI sets).
	if (process.env.PDFTOTEXT_BIN) return process.env.PDFTOTEXT_BIN;
	// 2. On PATH (Linux/CI poppler-utils; any Windows install that put it on PATH).
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	// 3. Known fallbacks: the Xpdf/poppler build bundled with Git for Windows lives in mingw64\bin, which is
	//    on Git Bash's PATH but NOT PowerShell's - so the PATH scan above misses it on a normal Windows shell.
	const fallbacks = [
		'C:/Program Files/Git/mingw64/bin/pdftotext.exe',
		'C:/Program Files (x86)/Git/mingw64/bin/pdftotext.exe'
	];
	for (const f of fallbacks) if (existsSync(f)) return f;
	throw new Error(
		'E_INGEST_NO_PDFTOTEXT: pdftotext not found (set PDFTOTEXT_BIN to its full path)'
	);
}
const PDFTOTEXT = resolvePdftotext();

/** pdfjs (our extractor, A2-D2): captured bytes -> per-page text items -> the pure assemblePdfText. */
async function extractPdfjs(bytes) {
	const loadingTask = getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 });
	const doc = await loadingTask.promise;
	const pages = [];
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n);
		const content = await page.getTextContent();
		// pdfjs yields TextItem ({str,hasEOL}) + TextMarkedContent (no str) - keep only real text items.
		const items = content.items
			.filter((it) => typeof it.str === 'string')
			.map((it) => ({ str: it.str, hasEOL: it.hasEOL === true }));
		pages.push(items);
	}
	await loadingTask.destroy(); // cleanup lives on the loading task (PDFDocumentProxy has no public destroy)
	return assemblePdfText(pages);
}

/** pdftotext (independent cross-check, A2-D6): raw text -> the SAME normalizeText, for a fair compare. */
function extractPdftotext(path) {
	const raw = execFileSync(PDFTOTEXT, ['-q', '-enc', 'UTF-8', path, '-'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	return normalizeText(raw);
}

/** Pull the staged filename from an entry's terms_notes ("...File: <name>.pdf..."). */
function stagedFileName(entry) {
	const m = /File:\s*(\S+\.pdf)/i.exec(entry.terms_notes ?? '');
	return m ? m[1] : null;
}

// --- Run ---
mkdirSync(CAPTURES_DIR, { recursive: true });
mkdirSync(EXTRACTED_DIR, { recursive: true });

const entries = parse(readFileSync(SOURCES_YAML, 'utf8'));
const pdfs = entries.filter((e) => e.content_type === 'pdf');

console.log('='.repeat(60));
console.log(
	`A2 INGEST - PDF stage  (${pdfs.length} sources, fidelity threshold ${FIDELITY_THRESHOLD})`
);
console.log(`staging: ${STAGING_DIR}`);
console.log('='.repeat(60));

const results = [];
for (const entry of pdfs) {
	try {
		const file = stagedFileName(entry);
		if (!file) throw new Error('E_INGEST_NO_FILE_REF');
		const srcPath = join(STAGING_DIR, file);
		if (!existsSync(srcPath)) throw new Error('E_INGEST_STAGED_MISSING');

		const bytes = new Uint8Array(readFileSync(srcPath));
		const record = await auditCopyRecord(bytes, 'pdf');
		// Idempotent: content-addressed -> identical bytes give the same path; write only if absent.
		if (!existsSync(record.capturedPath)) writeFileSync(record.capturedPath, bytes);

		const ours = await extractPdfjs(bytes);
		const poppler = extractPdftotext(srcPath);
		const similarity = trigramSimilarity(ours.normalizedText, poppler);
		const sanity = checkExtractionSanity(ours.normalizedText, { pages: ours.blocks.length });
		const pass = sanity.ok && similarity >= FIDELITY_THRESHOLD;

		writeFileSync(
			join(EXTRACTED_DIR, `${entry.source_id}.json`),
			JSON.stringify(
				{
					source_id: entry.source_id,
					content_hash: record.contentHash,
					extractionMode: ours.extractionMode,
					textLayerPresent: ours.textLayerPresent,
					fidelity: { similarity, sanity, pass },
					blocks: ours.blocks,
					normalizedText: ours.normalizedText
				},
				null,
				2
			)
		);

		results.push({ id: entry.source_id, similarity, sanity, pass });
		console.log(
			`${pass ? 'PASS' : 'FLAG'}  ${similarity.toFixed(4)}  ${entry.source_id}  ` +
				`(${ours.blocks.length}p, ${ours.extractionMode}${sanity.ok ? '' : ', ' + sanity.issues.join('/')})`
		);
	} catch (err) {
		// Fail-closed (A2): never silently drop a source - print the id + reason and stop the build.
		console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
		process.exit(1);
	}
}

// Distribution -> lock the A2-D6 threshold just below the clean cluster.
const sims = results.map((r) => r.similarity).sort((a, b) => a - b);
console.log('\n' + '='.repeat(60));
console.log('A2-D6 FIDELITY DISTRIBUTION (sorted ascending)');
console.log('='.repeat(60));
for (const r of [...results].sort((a, b) => a.similarity - b.similarity)) {
	console.log(`    ${r.similarity.toFixed(4)}  ${r.pass ? '    ' : 'FLAG'}  ${r.id}`);
}
const flagged = results.filter((r) => !r.pass).length;
console.log(
	`\n    min=${sims[0].toFixed(4)}  median=${sims[Math.floor(sims.length / 2)].toFixed(4)}  ` +
		`max=${sims[sims.length - 1].toFixed(4)}`
);
console.log(
	`    captures -> ${CAPTURES_DIR}/  extracted -> ${EXTRACTED_DIR}/  flagged@${FIDELITY_THRESHOLD}=${flagged}`
);
