// content-ops/capture-extract.mjs
// Run from the repo root: `pnpm ingest`. Pass source_id(s) or a content_type ('pdf' / 'html') to scope the
// run, e.g. `pnpm exec tsx content-ops/capture-extract.mjs va_intent_to_file` for a single source.
//
// Build-time ingest engine: captures + extracts text from the public-domain sources into a static,
// content-addressed corpus that ships to users for offline reading. It never runs on a user device or a live
// server. The complexity lives in the tested pure units under src/lib/content-ops/; this script only does the
// IO + the library calls. The extraction libraries (pdfjs, linkedom, Playwright) and yaml run
// only here, never in a src/ runtime module, so a runtime vuln in one cannot reach a shipped user.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, delimiter } from 'node:path';
import { parse } from 'yaml';
// legacy = the Node build; the default build constructs `new DOMMatrix()` (a browser global) at load.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseHTML } from 'linkedom';
import { chromium } from 'playwright';
import { auditCopyRecord } from '../src/lib/content-ops/capture/audit-copy.ts';
import { stagedFileName } from '../src/lib/content-ops/capture/staged-file.ts';
import { assemblePdfText } from '../src/lib/content-ops/extract/pdf-text.ts';
import { trigramSimilarity } from '../src/lib/content-ops/extract/similarity.ts';
import { checkExtractionSanity } from '../src/lib/content-ops/extract/fidelity.ts';
import { shapeHtmlBlocks } from '../src/lib/content-ops/extract/html-blocks.ts';
import { findOffOriginUrls } from '../src/lib/content-ops/extract/off-origin.ts';
import { isPathAllowed } from '../src/lib/content-ops/capture/robots.ts';
import { createRateLimiter } from '../src/lib/content-ops/capture/rate-limit.ts';
import { normalizeText } from '../src/lib/corpus/normalize.ts';

// Config (env override wins; repo-relative defaults).
const SOURCES_YAML = 'content/sources.yaml';
// When REFRESH_STAGING_ROOT is set, the OUTPUT dirs (captures + extracted) redirect under it so
// `pnpm refresh` can re-capture a fresh copy for change-detection WITHOUT clobbering the shipped baseline.
// Inputs (staged PDFs + manual HTML) stay at their real paths. Unset = normal ingest (byte-identical behavior).
const REFRESH_STAGING_ROOT = process.env.REFRESH_STAGING_ROOT;
const REFRESH_MODE = REFRESH_STAGING_ROOT !== undefined;
const STAGING_DIR = process.env.TAP_PDF_DIR ?? 'content-ops/staged'; // the byte-exact staged PDF originals
const CAPTURES_DIR = REFRESH_MODE ? join(REFRESH_STAGING_ROOT, 'captures') : 'content-ops/captures'; // content-addressed audit copies (never served)
const EXTRACTED_DIR = REFRESH_MODE
	? join(REFRESH_STAGING_ROOT, 'extracted')
	: 'content-ops/extracted'; // per-source extractor output
const MANUAL_HTML_DIR = 'content-ops/staged/manual-html'; // human-saved page HTML for bot-blocked sources

// Identifying User-Agent for polite scraping; contact URL added once the domain is decided.
const USER_AGENT = 'MilTransitionCompanion/1.0 (+contact: pending domain)';

// Sources whose host blocks a plain fetch: dol renders under a real headless browser; tsp is Akamai-protected
// (blocks headless too) -> manual saved-HTML, the last resort (we do not defeat bot-protection).
const CAPTURE_HEADLESS = new Set(['dol_tap_overview']);
const CAPTURE_MANUAL = new Set(['tsp_separation']);

// Cross-tool agreement threshold, set from the real distribution: the clean cluster floors at 0.86 and the
// worst flagged is 0.75, so 0.80 sits in the gap - passing the clean docs, flagging the structurally-complex
// ones for human review. Below it = flagged, never silently shipped. Order-sensitive by design (it scores
// layout divergence, not just corruption) - the safe bias for a fidelity gate.
const FIDELITY_THRESHOLD = 0.8;

// Optional CLI args (source_id(s) and/or a content_type) scope the run; no args = the whole corpus.
const ARGS = process.argv.slice(2);
const pick = (list) =>
	ARGS.length
		? list.filter((e) => ARGS.includes(e.source_id) || ARGS.includes(e.content_type))
		: list;

// One shared rate limiter (1 req/sec). Real clock here; the unit test injects a fake one.
const limiter = createRateLimiter(1000, {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
});

/** Resolve pdftotext to a full path: Node's execFileSync does NOT apply Windows PATHEXT to a bare name, so a
 *  plain 'pdftotext' ENOENTs even when on PATH. Env override wins; else scan PATH (+ PATHEXT on win). */
function resolvePdftotext() {
	const name = process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext';
	// Explicit override wins (the portable escape hatch; also what CI sets).
	if (process.env.PDFTOTEXT_BIN) return process.env.PDFTOTEXT_BIN;
	// Else scan PATH (Linux/CI poppler-utils; any Windows install that put it on PATH).
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir && existsSync(join(dir, name))) return join(dir, name);
	}
	// Git for Windows bundles poppler in mingw64\bin, which is on Git Bash's PATH but NOT PowerShell's - so
	// the PATH scan above misses it on a normal Windows shell.
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

/** pdfjs extract: captured bytes -> per-page text items -> the pure assemblePdfText. */
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

/** pdftotext (independent cross-check): raw text -> the same normalizeText, for a fair compare. */
function extractPdftotext(path) {
	const raw = execFileSync(PDFTOTEXT, ['-q', '-enc', 'UTF-8', path, '-'], {
		encoding: 'utf8',
		maxBuffer: 64 * 1024 * 1024
	});
	return normalizeText(raw);
}

/** Strip non-content + active/embeddable elements (script/style/template/iframe/object/embed/noscript) and
 *  off-origin asset elements from a linkedom document, so the extracted text is content-only and emits zero
 *  off-origin requests if rendered. Same-origin + relative assets stay. */
function sanitizeDocument(document, pageOrigin) {
	for (const el of document.querySelectorAll(
		'script, style, template, iframe, object, embed, noscript'
	))
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

// Content-bearing block elements. A nested block (a <p> inside a <li>) is captured by its OUTERMOST
// block's textContent, so we keep only blocks with no block ancestor inside the region (de-nesting) -
// otherwise the inner text would be counted twice.
const BLOCK_TAGS = [
	'p',
	'li',
	'h1',
	'h2',
	'h3',
	'h4',
	'h5',
	'h6',
	'blockquote',
	'dt',
	'dd',
	'td',
	'figcaption'
];
// Inline tags prefixed with a LEADING space so a CTA/link abutting the prior text with no source whitespace
// ("...different page.Use the VA Portal") does not fuse. Leading-only (not trailing), so a link right before
// punctuation ("711)") gains no stray space before it. Links are never mid-word, so the space (collapsed
// later by normalizeText) cannot split a word; emphasis tags (strong/em/sup/span) are NOT padded.
const SPACING_INLINE = new Set(['a', 'button']);

/** Pick the article region semantically (<main> then <article>); fail closed if neither exists, then
 *  drop in-region nav/aside/footer/header so only real content survives. */
function selectContentRegion(document) {
	const region = document.querySelector('main') ?? document.querySelector('article');
	if (!region) throw new Error('E_INGEST_NO_CONTENT_REGION');
	for (const el of region.querySelectorAll('nav, aside, footer, header')) el.remove();
	return region;
}

/** True if `el` has a block-element ancestor between it and the region (so its text is already counted
 *  by that outer block). */
function hasBlockAncestor(el, region) {
	for (let p = el.parentElement; p && p !== region; p = p.parentElement) {
		if (BLOCK_TAGS.includes(p.tagName.toLowerCase())) return true;
	}
	return false;
}

/** A block's text, depth-first like textContent but prefixing link/button text with a LEADING space so an
 *  inline CTA abutting the prior text does not fuse ("page.Use" -> "page. Use"); leading-only avoids a stray
 *  space before trailing punctuation. normalizeText later collapses the space. */
function blockText(node) {
	let out = '';
	for (const child of node.childNodes) {
		if (child.nodeType === 3)
			out += child.nodeValue ?? ''; // text node
		else if (child.nodeType === 1) {
			// element: recurse; prefix link-like inline tags with a space so a CTA does not glue onto prior text
			const inner = blockText(child);
			out += SPACING_INLINE.has(child.tagName.toLowerCase()) ? ` ${inner}` : inner;
		}
	}
	return out;
}

/** De-nested block walk: outermost content-bearing blocks in document order -> { text, tag }. */
function walkBlocks(region) {
	const seq = [];
	for (const el of region.querySelectorAll(BLOCK_TAGS.join(','))) {
		if (hasBlockAncestor(el, region)) continue;
		const text = blockText(el).trim();
		if (text) seq.push({ text, tag: el.tagName.toLowerCase() });
	}
	return seq;
}

/** linkedom block-aware extract: parse -> sanitize -> select region -> de-nested walk -> shape -> off-origin assert. */
function extractHtml(rawHtml, pageOrigin) {
	const { document } = parseHTML(rawHtml);
	sanitizeDocument(document, pageOrigin); // strip scripts/embeds + off-origin assets first
	const region = selectContentRegion(document);
	const result = shapeHtmlBlocks(walkBlocks(region));
	// Hard gate: zero off-origin asset URLs in the extracted text we ship (defense-in-depth tripwire).
	const offOrigin = findOffOriginUrls(result.normalizedText, pageOrigin);
	if (offOrigin.length > 0) {
		console.error(`    off-origin assets in extracted text: ${offOrigin.slice(0, 8).join(' | ')}`);
		throw new Error('E_INGEST_HTML_OFF_ORIGIN');
	}
	return result;
}

/** Honor robots.txt. Unreachable robots = allow (nothing to honor). Rate-limited fetch. */
async function robotsAllows(origin, pathname) {
	await limiter.acquire();
	try {
		const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENT } });
		if (r.ok) return isPathAllowed(await r.text(), USER_AGENT, pathname);
	} catch {
		// unreachable robots.txt -> nothing to honor
	}
	return true;
}

/** Shared finisher for every HTML capture method (fetch / headless / manual): audit copy + extract + write
 *  the per-source extracted JSON. `bytes` = the captured bytes; `rawHtml` = those bytes as text for
 *  extraction; `method` is recorded for provenance. */
async function writeHtmlArtifacts(entry, origin, bytes, rawHtml, method) {
	const record = await auditCopyRecord(bytes, 'html');
	// Path from CAPTURES_DIR (not record.capturedPath) so the staging redirect applies; normal mode
	// is byte-identical (CAPTURES_DIR = content-ops/captures).
	const capturedPath = join(CAPTURES_DIR, `${record.contentHash}.html`);
	if (!existsSync(capturedPath)) writeFileSync(capturedPath, bytes);
	const result = extractHtml(rawHtml, origin);
	writeFileSync(
		join(EXTRACTED_DIR, `${entry.source_id}.json`),
		JSON.stringify(
			{
				source_id: entry.source_id,
				content_hash: record.contentHash,
				extractionMode: result.extractionMode,
				textLayerPresent: result.textLayerPresent,
				capture_method: method,
				blocks: result.blocks,
				normalizedText: result.normalizedText
			},
			null,
			2
		)
	);
	return { id: entry.source_id, chars: result.normalizedText.length };
}

/** Plain-fetch HTML capture: robots -> rate-limited UA fetch -> shared finisher. */
async function captureHtml(entry) {
	const pageUrl = new URL(entry.url);
	const origin = pageUrl.origin;
	if (!(await robotsAllows(origin, pageUrl.pathname)))
		throw new Error('E_INGEST_ROBOTS_DISALLOWED');
	await limiter.acquire();
	const res = await fetch(entry.url, { headers: { 'user-agent': USER_AGENT } });
	if (!res.ok) throw new Error('E_INGEST_FETCH_BLOCKED');
	const bytes = new Uint8Array(await res.arrayBuffer()); // byte-exact audit copy
	return writeHtmlArtifacts(entry, origin, bytes, new TextDecoder('utf-8').decode(bytes), 'fetch');
}

/** Headless HTML capture: a real browser renders a page that blocked the plain fetch. The rendered DOM is the
 *  audit copy (the raw HTML is a bot-blocked shell). Shares one browser instance across sources. */
async function captureHtmlHeadless(entry, browser) {
	const pageUrl = new URL(entry.url);
	const origin = pageUrl.origin;
	if (!(await robotsAllows(origin, pageUrl.pathname)))
		throw new Error('E_INGEST_ROBOTS_DISALLOWED');
	await limiter.acquire();
	const page = await browser.newPage({ userAgent: USER_AGENT });
	try {
		const res = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
		if (!res || !res.ok()) throw new Error('E_INGEST_HEADLESS_BLOCKED');
		await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); // best-effort settle
		const rawHtml = await page.content();
		return writeHtmlArtifacts(
			entry,
			origin,
			new TextEncoder().encode(rawHtml),
			rawHtml,
			'headless'
		);
	} finally {
		await page.close();
	}
}

/** Manual HTML capture (last resort): ingest a human-saved page HTML for an Akamai-blocked source. Throws
 *  E_INGEST_MANUAL_HTML_MISSING (handled with on-screen instructions) if the file is absent. */
async function captureHtmlManual(entry) {
	const file = join(MANUAL_HTML_DIR, `${entry.source_id}.html`);
	if (!existsSync(file)) throw new Error('E_INGEST_MANUAL_HTML_MISSING');
	const pageUrl = new URL(entry.url);
	// Honor robots.txt even for a manually-saved source, so robots_allowed reflects a real check (unreachable
	// robots.txt -> allowed = "nothing to honor"); keeps the fail-closed-on-disallow invariant on every path.
	if (!(await robotsAllows(pageUrl.origin, pageUrl.pathname)))
		throw new Error('E_INGEST_ROBOTS_DISALLOWED');
	const bytes = new Uint8Array(readFileSync(file));
	return writeHtmlArtifacts(
		entry,
		pageUrl.origin,
		bytes,
		new TextDecoder('utf-8').decode(bytes),
		'manual'
	);
}

/** PDF stage: per source, capture (hash + audit copy) + pdfjs extract + the fidelity cross-check. */
async function runPdfStage(pdfs) {
	console.log('='.repeat(60));
	console.log(
		`INGEST - PDF stage  (${pdfs.length} sources, fidelity threshold ${FIDELITY_THRESHOLD})`
	);
	console.log(`staging: ${STAGING_DIR}`);
	console.log('='.repeat(60));

	const results = [];
	for (const entry of pdfs) {
		try {
			const file = stagedFileName(entry.terms_notes);
			if (!file) throw new Error('E_INGEST_NO_FILE_REF');
			// The staged name comes from our registry's terms_notes but must never contain a path separator
			// / '..' that could escape STAGING_DIR.
			if (file.includes('/') || file.includes('\\') || file.includes('..'))
				throw new Error('E_INGEST_BAD_STAGED_NAME');
			const srcPath = join(STAGING_DIR, file);
			if (!existsSync(srcPath)) throw new Error('E_INGEST_STAGED_MISSING');

			const bytes = new Uint8Array(readFileSync(srcPath));
			const record = await auditCopyRecord(bytes, 'pdf');
			// Idempotent: content-addressed -> identical bytes give the same path; write only if absent.
			// Path from CAPTURES_DIR so the staging redirect applies (normal mode byte-identical).
			const capturedPath = join(CAPTURES_DIR, `${record.contentHash}.pdf`);
			if (!existsSync(capturedPath)) writeFileSync(capturedPath, bytes);

			const ours = await extractPdfjs(bytes);
			// Parity smoke (sampled): pdfjs must be deterministic - the first PDF is re-extracted and must
			// round-trip byte-identical, else a pdfjs nondeterminism / version drift would silently invalidate
			// the downstream anchors. Fail closed. (Cross-version drift is also caught by the cross-tool
			// fidelity check + the per-ingest content review.)
			if (results.length === 0) {
				// pdfjs transfers (detaches) the input buffer, so re-read fresh bytes for the re-extract.
				const reExtract = await extractPdfjs(new Uint8Array(readFileSync(srcPath)));
				if (reExtract.normalizedText !== ours.normalizedText)
					throw new Error('E_INGEST_PDF_PARITY_DRIFT');
			}
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
			// Fail closed: never silently drop a source - print the id + reason and stop the build.
			console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
			process.exit(1);
		}
	}

	const sims = results.map((r) => r.similarity).sort((a, b) => a - b);
	console.log('\n' + '='.repeat(60));
	console.log('FIDELITY DISTRIBUTION (sorted ascending)');
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

/** HTML fetch stage: per source, robots -> rate-limited UA fetch -> audit copy -> linkedom block-aware. */
async function runHtmlStage(htmls) {
	console.log('\n' + '='.repeat(60));
	console.log(`INGEST - HTML stage  (${htmls.length} sources)`);
	console.log('='.repeat(60));

	for (const entry of htmls) {
		try {
			const r = await captureHtml(entry);
			console.log(`PASS  ${r.id}  (${r.chars.toLocaleString()} chars)`);
		} catch (err) {
			// Fail closed: never silently drop a source - print the id + reason and stop the build.
			console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
			process.exit(1);
		}
	}
	console.log(`\n    extracted -> ${EXTRACTED_DIR}/  captures -> ${CAPTURES_DIR}/`);
}

/** Headless stage: sources that blocked the plain fetch but a real browser can still render. */
async function runHeadlessStage(sources) {
	console.log('\n' + '='.repeat(60));
	console.log(`INGEST - HTML headless stage  (${sources.length} sources, render via Playwright)`);
	console.log('='.repeat(60));
	const browser = await chromium.launch({ headless: true });
	try {
		for (const entry of sources) {
			try {
				const r = await captureHtmlHeadless(entry, browser);
				console.log(
					`PASS  ${r.id}  (${r.chars.toLocaleString()} chars)  [headless; VERIFY real public body]`
				);
			} catch (err) {
				console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
				process.exit(1);
			}
		}
	} finally {
		await browser.close();
	}
}

/** Manual stage (last resort): Akamai-blocked sources captured from human-saved HTML. A missing file is NOT a
 *  crash - it prints the exact to-do (open URL -> save HTML to MANUAL_HTML_DIR) then fails closed so the
 *  source is never silently dropped. Full step-by-step instructions live in MANUAL_HTML_DIR/README.txt. */
async function runManualStage(sources) {
	console.log('\n' + '='.repeat(60));
	console.log(`INGEST - HTML manual stage  (${sources.length} Akamai-blocked; human-saved HTML)`);
	console.log('='.repeat(60));
	const missing = [];
	for (const entry of sources) {
		try {
			const r = await captureHtmlManual(entry);
			console.log(`PASS  ${r.id}  (${r.chars.toLocaleString()} chars)  [from saved HTML]`);
		} catch (err) {
			if (err.message === 'E_INGEST_MANUAL_HTML_MISSING') missing.push(entry);
			else {
				console.error(`[FAIL] ${entry.source_id}: ${err.message}`);
				process.exit(1);
			}
		}
	}
	if (missing.length > 0) {
		console.error(
			`\n  MANUAL CAPTURE NEEDED (${missing.length}) -> full steps in ${MANUAL_HTML_DIR}/README.txt`
		);
		for (const e of missing) {
			console.error(`    ${e.source_id}:`);
			console.error(`        1. open ${e.url}`);
			console.error(
				`        2. save the page as "HTML only" -> ${MANUAL_HTML_DIR}/${e.source_id}.html`
			);
			console.error(`        3. re-run \`pnpm ingest\``);
		}
		process.exit(1);
	}
}

// --- Run ---
mkdirSync(CAPTURES_DIR, { recursive: true });
mkdirSync(EXTRACTED_DIR, { recursive: true });
mkdirSync(MANUAL_HTML_DIR, { recursive: true });

const entries = parse(readFileSync(SOURCES_YAML, 'utf8'));
const pdfs = pick(entries.filter((e) => e.content_type === 'pdf'));
const htmls = pick(entries.filter((e) => e.content_type === 'html'));
const htmlFetch = htmls.filter(
	(e) => !CAPTURE_HEADLESS.has(e.source_id) && !CAPTURE_MANUAL.has(e.source_id)
);
const htmlHeadless = htmls.filter((e) => CAPTURE_HEADLESS.has(e.source_id));
const htmlManual = htmls.filter((e) => CAPTURE_MANUAL.has(e.source_id));

// In refresh mode, capture ONLY the auto-fetchable sources (plain fetch + headless). PDFs (tapevents SPA) and
// Akamai-blocked manual sources are `manual-check-required` for detection - refresh.mjs surfaces them instead.
if (pdfs.length && !REFRESH_MODE) await runPdfStage(pdfs);
if (htmlFetch.length) await runHtmlStage(htmlFetch);
if (htmlHeadless.length) await runHeadlessStage(htmlHeadless);
if (htmlManual.length && !REFRESH_MODE) await runManualStage(htmlManual);
