import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	highest,
	marginFor,
	parseBand,
	planApply,
	planFinal,
	suggestRaise,
	readLimits,
	rewriteLimits,
	type Sizes
} from './size-band-policy';

const BUDGET_SCRIPT = readFileSync(
	join(process.cwd(), 'content-ops/check-chunk-budget.mjs'),
	'utf8'
);
const PACKAGE_JSON = readFileSync(join(process.cwd(), 'package.json'), 'utf8');

// main at 550ce7a5, measured 2026-10-28: the baseline the money-tools plan's band was asked from.
const BASE: Sizes = {
	page: 104_029,
	onDemand: 16_091,
	precacheFiles: 80,
	precacheBytes: 253_591,
	workerScripts: 147_077,
	routeNodes: 59_809,
	rootLayout: 9_758
};
const LIMITS: Sizes = {
	page: 104_076,
	onDemand: 16_137,
	precacheFiles: 80,
	precacheBytes: 253_668,
	workerScripts: 147_200,
	routeNodes: 59_865,
	rootLayout: 9_820
};
const BAND = parseBand({
	plan: 'docs/superpowers/plans/2026-10-28-money-tools.md',
	approved: '2026-10-28',
	base: BASE,
	limit: LIMITS,
	raise: { page: 390, precacheBytes: 390, routeNodes: 90, onDemand: 90 }
});

describe('marginFor', () => {
	it('keeps at least 40 B, above the ~25 B a build drifts between commits', () => {
		expect(marginFor(0)).toBe(40);
		expect(marginFor(264)).toBe(40);
	});

	it('is 10% of the growth, rounded up, once that is larger', () => {
		expect(marginFor(1_001)).toBe(101);
	});
});

describe('highest', () => {
	it('takes each line from the largest of several builds, so a smaller build never sets a limit', () => {
		const a = { ...BASE, page: 104_300 };
		const b = { ...BASE, page: 104_280, routeNodes: 59_830 };
		expect(highest([a, b])).toEqual({ ...BASE, page: 104_300, routeNodes: 59_830 });
	});
});

describe('planApply', () => {
	it('raises a line to its size plus the margin when the raise fits the approved band', () => {
		const measured = { ...BASE, page: 104_300 };
		expect(planApply(BAND, measured, LIMITS)).toEqual({
			ok: true,
			changes: [
				{ line: 'page', from: 104_076, to: 104_340, measured: 104_300, growth: 271, margin: 40 }
			]
		});
	});

	it('writes nothing - not even the lines that fit - when one line needs more than its band', () => {
		const over = planApply(BAND, { ...BASE, page: 104_300, precacheBytes: 254_100 }, LIMITS);
		expect(over).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'precacheBytes', need: 254_151, allowed: 254_058, measured: 254_100 }]
		});
	});

	// A real run: page builds of the same code measured 104,478-104,506 B, so a band set from one build came in 8 B
	// short on the next. A small overrun is applied and reported, not asked; a larger one still stops.
	it('applies a raise up to the standing allowance past the band, and reports how far past it went', () => {
		const band = { ...BAND, raise: { ...BAND.raise, page: 460 } };
		expect(planApply(band, { ...BASE, page: 104_497 }, LIMITS)).toEqual({
			ok: true,
			changes: [
				{
					line: 'page',
					from: 104_076,
					to: 104_544,
					measured: 104_497,
					growth: 468,
					margin: 47,
					overBand: 8
				}
			]
		});
	});

	it('refuses past the standing allowance: 50 B, or 10% of the band when that is larger', () => {
		const band = { ...BAND, raise: { ...BAND.raise, page: 460 } };
		// allowed 104,536 + 50 = 104,586; 104,540 B (margin 52 B) needs 104,592.
		expect(planApply(band, { ...BASE, page: 104_540 }, LIMITS)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_592, allowed: 104_536, measured: 104_540 }]
		});
		// 48 B past a 460 B band: inside the 50 B floor, though past 10% of the band (46 B).
		expect(planApply(band, { ...BASE, page: 104_533 }, LIMITS).ok).toBe(true);
		const wide = { ...BAND, raise: { ...BAND.raise, page: 1_000 } };
		// allowed 105,076 + 100 = 105,176.
		expect(planApply(wide, { ...BASE, page: 105_050 }, LIMITS).ok).toBe(true);
		expect(planApply(wide, { ...BASE, page: 105_150 }, LIMITS).ok).toBe(false);
	});

	it('refuses a raise on a line the band does not list', () => {
		const plan = planApply(BAND, { ...BASE, rootLayout: 9_800 }, LIMITS);
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'rootLayout', need: 9_840, allowed: 9_820, measured: 9_800 }]
		});
	});

	// A line the band does not list stays at its current limit, even when main lowered it after the band was approved.
	it('never raises an unlisted line above its current limit', () => {
		const current = { ...LIMITS, workerScripts: 147_100 };
		expect(planApply(BAND, { ...BASE, workerScripts: 147_150 }, current)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'workerScripts', need: 147_190, allowed: 147_100, measured: 147_150 }]
		});
	});

	// A second apply on the same branch counts from the approved limit, so two raises never add up past the band.
	it('caps a line at the approved limit plus its band, not at a limit an earlier apply already raised', () => {
		const raised = { ...LIMITS, page: 104_340 };
		// The band's cap: 104,076 + 390 = 104,466, + the 50 B allowance = 104,516; 104,480 B needs 104,526.
		expect(planApply(BAND, { ...BASE, page: 104_480 }, raised)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_526, allowed: 104_466, measured: 104_480 }]
		});
	});

	it('refuses a file-count line over its limit; a count is never raised by the script', () => {
		const plan = planApply(BAND, { ...BASE, precacheFiles: 81 }, LIMITS);
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'precacheFiles', need: 81, allowed: 80, measured: 81 }]
		});
	});

	it('changes nothing when run again on the limits it wrote', () => {
		const measured = { ...BASE, page: 104_300 };
		const first = planApply(BAND, measured, LIMITS);
		const written = { ...LIMITS, page: first.changes[0]?.to ?? 0 };
		expect(planApply(BAND, measured, written)).toEqual({ ok: true, changes: [] });
	});
});

describe('planFinal', () => {
	it('lowers a band line left with more room than its margin, so padding never accumulates', () => {
		// Every other line already sits at its size plus 40 B, so only the page line has padding to give back.
		const tight = Object.fromEntries(
			Object.entries(BASE).map(([line, size]) => [
				line,
				line === 'precacheFiles' ? size : size + 40
			])
		) as Sizes;
		const limits = { ...tight, page: 104_340 };
		const measured = { ...BASE, page: 104_200 };
		expect(planFinal(BAND, measured, limits)).toEqual({
			ok: true,
			changes: [
				{ line: 'page', from: 104_340, to: 104_240, measured: 104_200, growth: 171, margin: 40 }
			]
		});
	});

	it("leaves a line outside the band alone, even with room: that padding is not this plan's to take", () => {
		// The band lines sit at their size plus 40 B; the worker line keeps its older 123 B of room.
		const limits = {
			...LIMITS,
			page: 104_069,
			onDemand: 16_131,
			precacheBytes: 253_631,
			routeNodes: 59_849
		};
		expect(LIMITS.workerScripts - BASE.workerScripts).toBeGreaterThan(40);
		expect(planFinal(BAND, BASE, limits)).toEqual({ ok: true, changes: [] });
	});

	it('fails a line over its limit: the end check sends it back to a trim pass, never to a raise', () => {
		const plan = planFinal(BAND, { ...BASE, page: 104_400 }, { ...LIMITS, page: 104_340 });
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_440, allowed: 104_340, measured: 104_400 }]
		});
	});
});

describe('suggestRaise', () => {
	// A real refusal: 254,060 B needs 254,107 B; a re-request at exactly 439 B failed the next build by drift alone.
	it('asks for the shortfall plus 40 B of drift, rounded up to 10 B, so the next build still fits', () => {
		const refusal = {
			line: 'precacheBytes' as const,
			need: 254_107,
			allowed: 254_098,
			measured: 254_060
		};
		expect(suggestRaise(BAND, refusal)).toBe(480);
	});
});

describe('parseBand', () => {
	it('refuses a band file that lacks a line or holds a negative raise', () => {
		expect(() => parseBand({ ...BAND, base: { ...BASE, page: undefined } })).toThrow(
			'E_SIZE_BAND_FILE'
		);
		expect(() => parseBand({ ...BAND, raise: { page: -1 } })).toThrow('E_SIZE_BAND_FILE');
		expect(() => parseBand({ ...BAND, raise: { precacheFiles: 1 } })).toThrow('E_SIZE_BAND_FILE');
		// A misspelt line would be ignored, and a fractional size would write a limit no check can meet.
		expect(() => parseBand({ ...BAND, raise: { pages: 100 } })).toThrow('E_SIZE_BAND_FILE');
		expect(() => parseBand({ ...BAND, base: { ...BASE, page: 104_029.5 } })).toThrow(
			'E_SIZE_BAND_FILE'
		);
	});
});

describe('rewriteLimits on the real budget files', () => {
	// Counted from the limits the files hold now, so a real raise committed later does not turn these into no-ops.
	const current = readLimits(BUDGET_SCRIPT, PACKAGE_JSON);
	const page = current.page + 264;
	const routeNodes = current.routeNodes + 25;
	const realChanges = [
		{
			line: 'page' as const,
			from: current.page,
			to: page,
			measured: page - 40,
			growth: 0,
			margin: 40
		},
		{
			line: 'routeNodes' as const,
			from: current.routeNodes,
			to: routeNodes,
			measured: routeNodes - 40,
			growth: 0,
			margin: 40
		}
	];
	const grouped = (n: number, separator: string) =>
		n.toLocaleString('en-US').replaceAll(',', separator);
	const out = rewriteLimits(BUDGET_SCRIPT, PACKAGE_JSON, realChanges, {
		date: '2026-10-28',
		reason: 'the money tools links'
	});

	it('writes the new limits where both checks read them', () => {
		const limits = readLimits(out.script, out.packageJson);
		expect(limits.page).toBe(page);
		expect(limits.routeNodes).toBe(routeNodes);
		expect(limits.onDemand).toBe(current.onDemand);
		const sizeLimit = JSON.parse(out.packageJson)['size-limit'] as {
			name: string;
			limit: string;
		}[];
		expect(sizeLimit.find((e) => e.name.startsWith('Lazy route nodes'))?.limit).toBe(
			`${routeNodes} B`
		);
	});

	it('changes only the limit lines and adds only comment lines, so no code beside them moves', () => {
		const before = BUDGET_SCRIPT.split('\n');
		const after = out.script.split('\n');
		const added = after.filter((line) => !before.includes(line));
		const removed = before.filter((line) => !after.includes(line));
		expect(removed).toEqual([`\tpage: ${grouped(current.page, '_')},`]);
		expect(added.filter((line) => !line.startsWith('//'))).toEqual([
			`\tpage: ${grouped(page, '_')},`
		]);
		const record = `page ${grouped(current.page, ',')} -> ${grouped(page, ',')}`;
		expect(added.some((line) => line.startsWith('//') && line.includes(record))).toBe(true);
		const pkgBefore = PACKAGE_JSON.split('\n');
		const pkgChanged = out.packageJson.split('\n').filter((line, i) => line !== pkgBefore[i]);
		expect(pkgChanged).toEqual([`\t\t\t"limit": "${routeNodes} B",`]);
	});

	// Without the record anchor a limit would change with no line saying why.
	it('refuses to rewrite when the record anchor is missing', () => {
		const noAnchor = BUDGET_SCRIPT.replace('measured reason recorded here', 'reason');
		expect(() =>
			rewriteLimits(noAnchor, PACKAGE_JSON, realChanges, { date: '2026-10-28', reason: 'x' })
		).toThrow('E_SIZE_BAND_ANCHOR');
	});

	// The reason is typed on the command line and written into a CI gate's source: a line break would write live code,
	// a `$&` would be read as a replacement pattern, and a non-ASCII character breaks the repo's ASCII rule.
	it('refuses a record reason that is not one line of plain ASCII text', () => {
		for (const reason of ['two\nlines', 'cost $& more', `caf${String.fromCharCode(233)}`, ''])
			expect(() =>
				rewriteLimits(BUDGET_SCRIPT, PACKAGE_JSON, realChanges, { date: '2026-10-28', reason })
			).toThrow('E_SIZE_BAND_REASON');
	});

	it('refuses to rewrite when a limit line cannot be found exactly once', () => {
		const record = { date: '2026-10-28', reason: 'x' };
		const missing = BUDGET_SCRIPT.replace(/\tpage: [\d_]+,\n/, '');
		expect(() => rewriteLimits(missing, PACKAGE_JSON, realChanges, record)).toThrow(
			'E_SIZE_BAND_ANCHOR'
		);
		// Two matches: the script could edit the wrong one, so it edits neither.
		const twice = BUDGET_SCRIPT.replace(/(\tpage: [\d_]+,\n)/, '$1$1');
		expect(() => rewriteLimits(twice, PACKAGE_JSON, realChanges, record)).toThrow(
			'E_SIZE_BAND_ANCHOR'
		);
	});
});
