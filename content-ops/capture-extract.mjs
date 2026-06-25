// content-ops/capture-extract.mjs
// Run from the repo root: `pnpm ingest` (= tsx content-ops/capture-extract.mjs). Pass source_id(s) or a
// content_type ('pdf' / 'html') as args to scope the run (e.g.
// `pnpm exec tsx content-ops/capture-extract.mjs va_intent_to_file` for a single source).
//
// A2 build-time INGEST ENGINE (capture + extract + fidelity). PRODUCER-SIDE / BUILD-TIME ONLY: this never
// runs on a user device or a live server. It produces the static, content-addressed corpus that ships to
// users, who only download + read it offline (ADR-018, local-first). A5 (Refresh) will later wrap this same
// engine in a scheduler - the engine is not rebuilt, just automated.
//
// Build-only: pdfjs-dist + child_process(pdftotext) + linkedom + Readability + yaml run HERE, never in a
// src/ runtime module (the no-third-party-runtime-JS rule; mirrors validate-sources.mjs). The complexity
// lives in tested pure units under src/lib/content-ops/; this script only does the IO + the library calls.
//
// AS-BUILT: PDF stage (pdfjs capture/extract + the A2-D6 fidelity cross-check vs pdftotext) + HTML stage
// (robots + rate-limited fetch + linkedom/Readability + sanitize + off-origin assert). PENDING increments:
// the 4 fetch-blocked sources (Playwright headless fallback) + the sources.yaml capture-field backfill.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { parse } from 'yaml';
// legacy = the Node build; the default build constructs `new DOMMatrix()` (a browser global) at load.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { auditCopyRecord } from '../src/lib/content-ops/capture/audit-copy.ts';
import { assemblePdfText } from '../src/lib/content-ops/extract/pdf-text.ts';
import { trigramSimilarity } from '../src/lib/content-ops/extract/similarity.ts';
import { checkExtractionSanity } from '../src/lib/content-ops/extract/fidelity.ts';
import { shapeHtmlExtraction } from '../src/lib/content-ops/extract/html-text.ts';
import { findOffOriginUrls } from '../src/lib/content-ops/extract/off-origin.ts';
import { isPathAllowed } from '../src/lib/content-ops/capture/robots.ts';
import { createRateLimiter } from '../src/lib/content-ops/capture/rate-limit.ts';
import { normalizeText } from '../src/lib/corpus/normalize.ts';

// Config - resolved, never machine-hardcoded (env override wins; sensible repo-relative defaults).
const SOURCES_YAML = 'content/sources.yaml';
const STAGING_DIR = process.env.TAP_PDF_DIR ?? 'content-ops/staged'; // where the byte-exact TAP originals sit
const CAPTURES_DIR = 'content-ops/captures'; // content-addressed audit copies (A2-D5; never served)
const EXTRACTED_DIR = 'content-ops/extracted'; // per-source extractor output (A3 input)

// Identifying User-Agent for polite scraping (master spec 8.5). Contact URL added once the domain is decided.
const USER_AGENT = 'MilTransitionCompanion/1.0 (+contact: pending domain)';

// The 4 sources that blocked automated fetch at A1 vetting -> the Playwright headless fallback (pending
// increment). Skipped by the plain-fetch HTML stage so a full run stays clean until that lands.
const FETCH_BLOCKED = new Set([
	'dol_tap_overview',
	'tsp_separation',
	'navy_separation',
	'dfas_final_pay'
]);

// A2-D6 threshold, LOCKED from the full 21-doc distribution (S31): the clean cluster floor is 0.8597 and the
// highest flagged is 0.7457, so 0.80 sits centered in that gap - passes all 18 clean docs with margin, flags
// the 3 most structurally-complex (TOC/columnar/interactive) for human review. Below it = flagged, never
// silently shipped. The metric is order-sensitive by design (it scores layout divergence, not just
// corruption) - the safe bias for a fidelity gate; a v2.x refinement could add auto-escalation (spec-deferred).
const FIDELITY_THRESHOLD = 0.8;

// Optional CLI args (source_id(s) and/or a content_type) scope the run; no args = the whole corpus. Lets a
// single source be verified before a full run (incremental, Max-gated).
const ARGS = process.argv.slice(2);
const pick = (list) =>
	ARGS.length
		? list.filter((e) => ARGS.includes(e.source_id) || ARGS.includes(e.content_type))
		: list;

// One rate limiter shared across the whole run (1 req/sec, master spec 8.5). Real clock here; the unit test
// injects a fake one.
const limiter = createRateLimiter(1000, {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
});

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

/** Remove active/embeddable elements + off-origin asset elements from a linkedom document (privacy: the
 *  extracted artifact must emit zero off-origin requests if rendered). Same-origin + relative assets stay. */
function sanitizeDocument(document, pageOrigin) {
	for (const el of document.querySelectorAll('script, iframe, object, embed, noscript'))
		el.remove();
	for (const el of document.querySelectorAll('img, source, video, audio, track')) {
		const src = el.getAttribute('src') ?? '';
		if (/^https?:\/\//i.test(src)) {
			try {
				if (new URL(src).origin !== pageOrigin) el.remove();
			} catch {
				el.remove();
			}
		}
	}
}

/** linkedom + Readability extract (A2-D3): parse -> sanitize -> main article -> off-origin assert -> shape. */
function extractHtml(rawHtml, pageOrigin) {
	const { document } = parseHTML(rawHtml);
	sanitizeDocument(document, pageOrigin); // strip scripts/embeds + off-origin assets so the article is clean
	const article = new Readability(document).parse();
	if (!article || !article.textContent || article.textContent.trim().length === 0)
		throw new Error('E_INGEST_HTML_NO_ARTICLE');
	const text = article.textContent;
	// Success-Charter HARD GATE: zero off-origin asset URLs in the EXTRACTED artifact (the text we ship). The
	// raw page's own analytics/RUM (e.g. Datadog) lives in the byte-exact audit copy only - never served
	// (A2-D5 / A1-D2 served:false) - so it is not the check surface. The shipped text is plain prose, so this
	// is a defense-in-depth tripwire against extraction ever embedding raw asset markup.
	const offOrigin = findOffOriginUrls(text, pageOrigin);
	if (offOrigin.length > 0) {
		console.error(`    off-origin assets in extracted text: ${offOrigin.slice(0, 8).join(' | ')}`);
		throw new Error('E_INGEST_HTML_OFF_ORIGIN');
	}
	// FLAG (A4 retrieval eval): Readability's `.textContent` runs inline elements together at structural
	// boundaries ("disabilityPension", "page.Use") - core sentence text is correctly spaced, only link/list/
	// heading seams are affected. Refine the extractor here if it measurably hurts recall.
	return shapeHtmlExtraction(text);
}

/** Capture + extract one HTML source: robots -> rate-limited fetch -> audit copy -> extract -> extracted JSON. */
async function captureHtml(entry) {
	const pageUrl = new URL(entry.url);
	const origin = pageUrl.origin;

	// robots.txt (honored always, master spec 8.5); unreachable robots = allow (nothing to honor).
	await limiter.acquire();
	let robotsAllowed = true;
	try {
		const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
		if (r.ok) robotsAllowed = isPathAllowed(await r.text(), USER_AGENT, pageUrl.pathname);
	} catch {
		robotsAllowed = true;
	}
	if (!robotsAllowed) throw new Error('E_INGEST_ROBOTS_DISALLOWED');

	// page fetch (rate-limited, identifying UA). A non-200 is the fetch-blocked signal -> Playwright (pending).
	await limiter.acquire();
	const res = await fetch(entry.url, { headers: { 'user-agent': USER_AGENT } });
	if (!res.ok) throw new Error('E_INGEST_FETCH_BLOCKED');
	const bytes = new Uint8Array(await res.arrayBuffer()); // byte-exact audit copy
	const rawHtml = new TextDecoder('utf-8').decode(bytes); // .gov pages are UTF-8

	const record = await auditCopyRecord(bytes, 'html');
	if (!existsSync(record.capturedPath)) writeFileSync(record.capturedPath, bytes);

	const result = extractHtml(rawHtml, origin);
	writeFileSync(
		join(EXTRACTED_DIR, `${entry.source_id}.json`),
		JSON.stringify(
			{
				source_id: entry.source_id,
				content_hash: record.contentHash,
				extractionMode: result.extractionMode,
				textLayerPresent: result.textLayerPresent,
				robots_allowed: robotsAllowed,
				blocks: result.blocks,
				normalizedText: result.normalizedText
			},
			null,
			2
		)
	);
	return { id: entry.source_id, chars: result.normalizedText.length };
}

/** PDF stage: per source, capture (hash + audit copy) + pdfjs extract + the A2-D6 fidelity cross-check. */
async function runPdfStage(pdfs) {
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

	// Distribution -> the A2-D6 threshold sits just below the clean cluster.
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
	console.log(`    flagged@${FIDELITY_THRESHOLD}=${flagged}  ->  ${EXTRACTED_DIR}/`);
}

/** HTML stage: per source, robots -> rate-limited UA fetch -> audit copy -> linkedom/Readability + sanitize. */
async function runHtmlStage(htmls) {
	console.log('\n' + '='.repeat(60));
	console.log(`A2 INGEST - HTML stage  (${htmls.length} sources)`);
	console.log('='.repeat(60));

	for (const entry of htmls) {
		if (FETCH_BLOCKED.has(entry.source_id)) {
			console.log(`SKIP  ${entry.source_id}  (fetch-blocked -> Playwright fallback, pending)`);
			continue;
		}
		try {
			const r = await captureHtml(entry);
			console.log(`PASS  ${r.id}  (${r.chars.toLocaleString()} chars)`);
		} catch (err) {
			// Fail-closed (A2): never silently drop a source - print the id + reason and stop the build.
			console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
			process.exit(1);
		}
	}
	console.log(`\n    extracted -> ${EXTRACTED_DIR}/  captures -> ${CAPTURES_DIR}/`);
}

// --- Run ---
mkdirSync(CAPTURES_DIR, { recursive: true });
mkdirSync(EXTRACTED_DIR, { recursive: true });

const entries = parse(readFileSync(SOURCES_YAML, 'utf8'));
const pdfs = pick(entries.filter((e) => e.content_type === 'pdf'));
const htmls = pick(entries.filter((e) => e.content_type === 'html'));

if (pdfs.length) await runPdfStage(pdfs);
if (htmls.length) await runHtmlStage(htmls);
