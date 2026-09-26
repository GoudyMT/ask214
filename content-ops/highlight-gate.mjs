/**
 * Measure whether a citation can actually reach its passage in the served document.
 *
 * Runs the SHIPPED matcher over every corpus chunk that carries a page and an anchor, against the real
 * documents, through the same PDF reader the app uses. Importing the shipped module rather than
 * reimplementing the search is the whole point: a gate with its own copy of the algorithm measures the
 * copy, and the two drift the moment either is tuned.
 *
 * Positive controls run FIRST and are printed BEFORE any rate. A harness that silently extracts nothing
 * reports 0% and looks like a product failure; one that matches everything reports 100% and looks like
 * success. Neither is detectable from the rate alone, and both have happened on this project.
 *
 * Run: pnpm highlight-gate
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findAnchorInDocument } from '../src/lib/sources/highlight-match.ts';
import { cleanExcerpt } from '../src/lib/corpus/index.ts';
import { stripHeadingEcho } from '../src/lib/ask/answer/heading-echo.ts';
import { selectAnswer } from '../src/lib/ask/answer/select-answer.ts';
import { LOCAL_DOCUMENTS } from '../src/lib/sources/local-documents.data.ts';
import { LOCAL_DOCUMENT_INFO } from '../src/lib/sources/local-document-info.data.ts';
import { OUTPUT_DIR, pageTexts, pdfSources, publishedName } from './served-pdf-io.mjs';
import { highlightPopulation } from './serve-pdfs-core.mjs';
import { CORPUS_BASE } from '../src/lib/ask/asset-cache.ts';

// The corpus the app loads, from the build: the same base path every page reads.
const CORPUS = `.svelte-kit/output/client${CORPUS_BASE}.json`;

// Pre-registered floors. Each records the value measured when it was set, so a later reader can see how
// much slack there is rather than guessing.
//
//   rightPage 0.99. The design bar: a citation opens its own document, at a page that document has. Its
//     population is every chunk from a served document that carries a page, anchored or not, because a
//     citation opens the page either way. Measured 100% (1,613 of 1,613) when the row was added.
//   located 0.95. Measured 96.1% over the full population, on both pdfjs 6.2.108 and 6.3.289 - the fold
//     is what makes it survive a reader change. About one point, or 18 chunks, of slack: real but not
//     generous, so left where it is rather than tightened onto the measurement.
//   onCitedPage 0.88. This floor was briefly raised to 0.90 against a reading of 91.1%, and that reading
//     was WRONG: the matcher was returning offsets into a normalized copy of the page while the page
//     bounds were computed from the raw text, so misaligned ranges overlapped the cited page by accident.
//     With the coordinates fixed the true figure is 89.1%, meaning the cited-page preference bought about
//     0.3pp rather than 2.3pp. The floor returns to the 0.88 that was honestly measured. This is a
//     correction of a floor set on a bad number, NOT a floor lowered to make a run pass - the difference
//     is that 0.88 was measured and 0.90 never was.
//   meanRanges 1.2. The design bar. Measured 1.27 before the window was bounded and 1.12 after. Left at
//     1.2 rather than tightened to 1.15: the remaining margin is 0.08, and a passage legitimately
//     crossing one more page boundary should not read as a regression.
//   quoteInside 0.95. The page view tints the QUOTED text - the words the answer block showed - and keeps
//     the whole passage as a bar, so the quote must be findable inside that passage on the cited page. Its
//     denominator is the passages marked on their cited page, NOT every chunk: a quote cannot be inside a
//     passage mark that does not exist, and that miss is already counted by onCitedPage. A throwaway
//     harness read 96.3% (1,383 of 1,436) before this bar existed; the floor sits under that reading.
//
// Same rule as the retrieval gate: raise a floor when the matcher genuinely improves; never lower one to
// make a run pass.
const FLOOR = {
	rightPage: 0.99,
	located: 0.95,
	onCitedPage: 0.88,
	meanRanges: 1.2,
	quoteInside: 0.95
};

/**
 * Whether a citation to this page of this source opens the right served document at a page it has.
 *
 * Reads the app's own generated maps - the path the reader opens and the page count the Documents area
 * states - and requires the path to be the one published for this source under its capture hash, not
 * merely some served file.
 *
 * @param {Map<string, {contentHash: string}>} byId Served sources by id.
 * @param {string} sourceId
 * @param {unknown} page The chunk's page, as the corpus records it.
 * @returns {boolean}
 */
function opensRightPage(byId, sourceId, page) {
	const source = byId.get(sourceId);
	const pages = LOCAL_DOCUMENT_INFO[sourceId]?.pages ?? 0;
	return (
		source !== undefined &&
		LOCAL_DOCUMENTS[sourceId] === `/docs/${publishedName(sourceId, source.contentHash)}` &&
		Number.isInteger(page) &&
		/** @type {number} */ (page) >= 1 &&
		/** @type {number} */ (page) <= pages
	);
}

/**
 * The quote exactly as the reader derives it from a chunk: cleaned for display, heading echo removed, then
 * the answer's opening window. Any other path would measure a quote no user ever sees.
 *
 * @param {{text: string, section?: string}} chunk
 * @returns {string}
 */
function readerQuote(chunk) {
	return selectAnswer(stripHeadingEcho(cleanExcerpt(chunk.text), chunk.section));
}

/**
 * Total characters a set of ranges covers.
 *
 * @param {{start: number, end: number}[]} ranges
 * @returns {number}
 */
function span(ranges) {
	return ranges.reduce((n, r) => n + (r.end - r.start), 0);
}

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted.length === 0 ? 0 : (sorted[Math.floor(sorted.length / 2)] ?? 0);
}

/**
 * Assert the harness can tell a real passage from an absent one, before any rate is believed.
 *
 * @param {string[]} pages
 * @param {[string, boolean][]} citationControls The same assertion for opening a cited page, made by the
 *   caller, which holds the served documents.
 * @returns {boolean}
 */
function runPositiveControls(pages, citationControls) {
	const body = pages.find((p) => p.length > 1200) ?? pages[0] ?? '';
	const slice = body.slice(200, 1100);
	const words = slice.split(' ').filter(Boolean);
	const stitched = [...words.slice(0, 30), ...words.slice(45)].join(' ');

	const asDoc = [body];
	const results = [
		['pages carry text at all', body.length > 500],
		['a verbatim slice resolves', (findAnchorInDocument(asDoc, 1, slice)?.coverage ?? 0) > 0.95],
		[
			'absent text does not resolve',
			findAnchorInDocument(
				asDoc,
				1,
				'zebra quixotic flugelhorn parsnip vortex cantilever mongoose'
			) === null
		],
		['a slice with a deleted run resolves', findAnchorInDocument(asDoc, 1, stitched) !== null],
		...citationControls
	];

	console.log('='.repeat(60));
	console.log('POSITIVE CONTROLS (read these before any rate)');
	console.log('='.repeat(60));
	for (const [label, pass] of results) console.log(`    [${pass ? 'PASS' : 'FAIL'}] ${label}`);
	const ok = results.every(([, pass]) => pass);
	console.log(`    instrument: ${ok ? 'VALIDATED' : 'BROKEN - the rate below means nothing'}\n`);
	return ok;
}

async function main() {
	const corpus = JSON.parse(readFileSync(CORPUS, 'utf-8'));
	const sources = pdfSources();
	const byId = new Map(sources.map((s) => [s.sourceId, s]));
	// Every paged chunk of a served document is measured; one with no anchor to search for is a miss.
	/** @type {{sourceId: string, page: number, text: string, section?: string, anchor: {exact: string}}[]} */
	const chunks = corpus.chunks;
	const { anchored: eligible, unanchored } = highlightPopulation(chunks, new Set(byId.keys()));

	// A page of 0 or a malformed page stays in, as a miss: the chunk claims a page, so it cites one.
	/** @type {{sourceId: string, page?: unknown}[]} */
	const withPage = corpus.chunks.filter(
		(/** @type {{page?: unknown}} */ c) => c.page !== undefined && c.page !== null
	);
	const paged = withPage.filter((c) => byId.has(c.sourceId));
	const wrongPage = paged.filter((c) => !opensRightPage(byId, c.sourceId, c.page));

	console.log('='.repeat(60));
	console.log('HIGHLIGHT GATE');
	console.log('='.repeat(60));
	console.log(
		`    pdfjs-dist ${JSON.parse(readFileSync('node_modules/pdfjs-dist/package.json', 'utf-8')).version}`
	);
	console.log(`    ${paged.length} chunks from served documents carry a page`);
	console.log(
		`    ${eligible.length} of them carry an anchor; ${unanchored.length} do not and count as misses\n`
	);

	const grouped = new Map();
	for (const chunk of eligible) {
		if (!byId.has(chunk.sourceId)) continue;
		if (!grouped.has(chunk.sourceId)) grouped.set(chunk.sourceId, []);
		grouped.get(chunk.sourceId).push(chunk);
	}

	let controlsDone = false;
	let attempted = unanchored.length;
	let located = 0;
	let onCitedPage = 0;
	let totalRanges = 0;
	let quoteInside = 0;
	/** @type {number[]} */
	const passageShares = [];
	/** @type {number[]} */
	const quoteShares = [];
	const perSource = [];
	const misses = unanchored.slice(0, 20).map((c) => `${c.sourceId} p${c.page}: no anchor`);

	const ids = [...grouped.keys()].sort();
	for (const [index, sourceId] of ids.entries()) {
		const source = byId.get(sourceId);
		if (source === undefined) continue;
		const served = join(OUTPUT_DIR, publishedName(sourceId, source.contentHash));
		process.stdout.write(`[${index + 1}/${ids.length}] ${sourceId}...`);
		const pages = await pageTexts(served);

		if (!controlsDone) {
			console.log();
			const last = LOCAL_DOCUMENT_INFO[sourceId]?.pages ?? 0;
			/** @type {[string, boolean][]} */
			const citationControls = [
				['a cited last page opens', opensRightPage(byId, sourceId, last)],
				['a page past the last does not open', !opensRightPage(byId, sourceId, last + 1)],
				['page 0 does not open', !opensRightPage(byId, sourceId, 0)],
				['an unserved source does not open', !opensRightPage(byId, 'no_such_source', 1)]
			];
			if (!runPositiveControls(pages, citationControls)) {
				throw new Error('E_HIGHLIGHT_GATE_INSTRUMENT');
			}
			controlsDone = true;
			process.stdout.write(`[${index + 1}/${ids.length}] ${sourceId}...`);
		}

		let hit = 0;
		const items = grouped.get(sourceId);
		for (const chunk of items) {
			attempted += 1;
			const match = findAnchorInDocument(pages, chunk.page, chunk.anchor.exact);
			if (match === null) {
				if (misses.length < 20) {
					misses.push(`${sourceId} p${chunk.page}: ${chunk.anchor.exact.slice(0, 80)}`);
				}
				continue;
			}
			located += 1;
			hit += 1;
			totalRanges += match.ranges.length;
			const passageOnPage = match.ranges.filter((r) => r.page === chunk.page);
			if (passageOnPage.length === 0) continue;
			onCitedPage += 1;

			const pageLength = pages[chunk.page - 1]?.length || 1;
			passageShares.push(span(passageOnPage) / pageLength);
			const quote = readerQuote(chunk);
			const found = quote === '' ? null : findAnchorInDocument(pages, chunk.page, quote);
			const quoteOnPage = (found?.ranges ?? []).filter(
				(r) =>
					r.page === chunk.page && passageOnPage.some((p) => r.start < p.end && p.start < r.end)
			);
			if (quoteOnPage.length > 0) {
				quoteInside += 1;
				quoteShares.push(span(quoteOnPage) / pageLength);
			}
		}
		perSource.push([sourceId, hit, items.length]);
		console.log(` ${hit}/${items.length}`);
	}

	const rate = (/** @type {number} */ n) => (attempted === 0 ? 0 : n / attempted);
	const measured = {
		rightPage: paged.length === 0 ? 0 : (paged.length - wrongPage.length) / paged.length,
		located: rate(located),
		onCitedPage: rate(onCitedPage),
		meanRanges: located === 0 ? 0 : totalRanges / located,
		quoteInside: onCitedPage === 0 ? 0 : quoteInside / onCitedPage
	};

	console.log(`\n${'='.repeat(60)}`);
	console.log('PER SOURCE');
	console.log('='.repeat(60));
	for (const [sourceId, hit, total] of perSource.sort((a, b) => a[1] / a[2] - b[1] / b[2])) {
		const pct = total === 0 ? 0 : (100 * hit) / total;
		console.log(
			`    ${sourceId.padEnd(32)} ${String(hit).padStart(4)}/${String(total).padEnd(4)} ${pct.toFixed(1)}%`
		);
	}

	if (misses.length > 0) {
		console.log(`\n${'='.repeat(60)}`);
		console.log(`MISS SAMPLE (${misses.length}) - read these, do not just count them`);
		console.log('='.repeat(60));
		for (const miss of misses) console.log(`    ${miss}`);
	}

	if (wrongPage.length > 0) {
		console.log(`\n${'='.repeat(60)}`);
		console.log(`WRONG DOCUMENT OR PAGE (${wrongPage.length}, first 20)`);
		console.log('='.repeat(60));
		for (const c of wrongPage.slice(0, 20)) console.log(`    ${c.sourceId} p${String(c.page)}`);
	}

	console.log(`\n${'='.repeat(60)}`);
	console.log('RESULT');
	console.log('='.repeat(60));
	/** @type {{label: string, value: number, floor: number, direction: 'min' | 'max'}[]} */
	const rows = [
		{
			label: 'right document, right page',
			value: measured.rightPage,
			floor: FLOOR.rightPage,
			direction: 'min'
		},
		{ label: 'passage located', value: measured.located, floor: FLOOR.located, direction: 'min' },
		{
			label: 'located AND on the cited page',
			value: measured.onCitedPage,
			floor: FLOOR.onCitedPage,
			direction: 'min'
		},
		{
			label: 'mean pages per highlight',
			value: measured.meanRanges,
			floor: FLOOR.meanRanges,
			direction: 'max'
		},
		{
			label: 'quote inside passage (of marked)',
			value: measured.quoteInside,
			floor: FLOOR.quoteInside,
			direction: 'min'
		}
	];
	let failed = 0;
	for (const { label, value, floor, direction } of rows) {
		const pass = direction === 'min' ? value >= floor : value <= floor;
		if (!pass) failed += 1;
		const shown = direction === 'min' ? `${(100 * value).toFixed(1)}%` : value.toFixed(2);
		const bar = direction === 'min' ? `>= ${(100 * floor).toFixed(0)}%` : `<= ${floor.toFixed(2)}`;
		console.log(
			`    ${label.padEnd(32)} ${shown.padStart(7)}  ${bar.padEnd(8)} ${pass ? 'PASS' : 'FAIL'}`
		);
	}
	console.log(
		`    ${'pages cited (right-page row)'.padEnd(32)} ${String(paged.length).padStart(7)}`
	);
	// Report only: a chunk whose source is not served opens no document here, so it is outside the row.
	console.log(
		`    ${'paged, source not served'.padEnd(32)} ${String(withPage.length - paged.length).padStart(7)}`
	);
	console.log(`    ${'chunks measured'.padEnd(32)} ${String(attempted).padStart(7)}`);
	console.log(`    ${'marked on their cited page'.padEnd(32)} ${String(onCitedPage).padStart(7)}`);
	// Report only: how much of its page each mark covers, which is what the quote tint exists to reduce.
	const share = (/** @type {number[]} */ v) => `${(100 * median(v)).toFixed(0)}%`;
	console.log(
		`    ${'median page share marked'.padEnd(32)} passage ${share(passageShares)}, quote ${share(quoteShares)}`
	);

	if (failed > 0) {
		console.log(`\nGATE FAILED on ${failed} bar(s). Do not lower a floor to make this pass.`);
		throw new Error('E_HIGHLIGHT_GATE_FAILED');
	}
	console.log('\nGATE PASSED');
}

await main();
