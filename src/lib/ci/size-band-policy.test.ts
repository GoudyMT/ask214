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
	// Measured builds carry one fixed version, so the same code measures the same bytes: no room is kept for drift.
	it('is 10% of the growth, rounded up, with no floor', () => {
		expect(marginFor(0)).toBe(0);
		expect(marginFor(264)).toBe(27);
		expect(marginFor(1_001)).toBe(101);
	});

	it('keeps no room for a line that shrank', () => {
		expect(marginFor(-50)).toBe(0);
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
				{ line: 'page', from: 104_076, to: 104_328, measured: 104_300, growth: 271, margin: 28 }
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

	// Every byte past the band is new code, so even a small overrun goes back to the owner as a re-request.
	it('refuses a line that needs even a few bytes past its band', () => {
		const band = { ...BAND, raise: { ...BAND.raise, page: 460 } };
		// allowed 104,076 + 460 = 104,536; 104,497 B (margin 47 B) needs 104,544.
		expect(planApply(band, { ...BASE, page: 104_497 }, LIMITS)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_544, allowed: 104_536, measured: 104_497 }]
		});
		// 104,488 B (margin 46 B) needs 104,534: inside the band.
		expect(planApply(band, { ...BASE, page: 104_488 }, LIMITS).ok).toBe(true);
	});

	it('refuses a raise on a line the band does not list', () => {
		const plan = planApply(BAND, { ...BASE, rootLayout: 9_818 }, LIMITS);
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'rootLayout', need: 9_824, allowed: 9_820, measured: 9_818 }]
		});
	});

	// A line the band does not list stays at its current limit, even when main lowered it after the band was approved.
	it('never raises an unlisted line above its current limit', () => {
		const current = { ...LIMITS, workerScripts: 147_100 };
		expect(planApply(BAND, { ...BASE, workerScripts: 147_150 }, current)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'workerScripts', need: 147_158, allowed: 147_100, measured: 147_150 }]
		});
	});

	// A second apply on the same branch counts from the approved limit, so two raises never add up past the band.
	it('caps a line at the approved limit plus its band, not at a limit an earlier apply already raised', () => {
		const raised = { ...LIMITS, page: 104_340 };
		// The band's cap: 104,076 + 390 = 104,466; 104,430 B (margin 41 B) needs 104,471.
		expect(planApply(BAND, { ...BASE, page: 104_430 }, raised)).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_471, allowed: 104_466, measured: 104_430 }]
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
		// The other band lines grew nothing and sit at their size, so only the page line has padding to give back.
		const limits = { ...BASE, page: 104_340 };
		const measured = { ...BASE, page: 104_200 };
		expect(planFinal(BAND, measured, limits)).toEqual({
			ok: true,
			changes: [
				{ line: 'page', from: 104_340, to: 104_218, measured: 104_200, growth: 171, margin: 18 }
			]
		});
	});

	// A line with no raise is treated as unlisted by apply, so the end check leaves it alone too.
	it('leaves a line listed with a 0 B raise alone, as apply treats it as unlisted', () => {
		const band = parseBand({ ...BAND, raise: { ...BAND.raise, onDemand: 0 } });
		const limits = { ...LIMITS, page: 104_029, precacheBytes: 253_591, routeNodes: 59_809 };
		expect(LIMITS.onDemand - BASE.onDemand).toBeGreaterThan(0);
		expect(planFinal(band, BASE, limits)).toEqual({ ok: true, changes: [] });
	});

	it("leaves a line outside the band alone, even with room: that padding is not this plan's to take", () => {
		// The band lines sit at their size; the worker line keeps its older 123 B of room.
		const limits = {
			...LIMITS,
			page: 104_029,
			onDemand: 16_091,
			precacheBytes: 253_591,
			routeNodes: 59_809
		};
		expect(LIMITS.workerScripts - BASE.workerScripts).toBeGreaterThan(0);
		expect(planFinal(BAND, BASE, limits)).toEqual({ ok: true, changes: [] });
	});

	it('fails a line over its limit: the end check sends it back to a trim pass, never to a raise', () => {
		const plan = planFinal(BAND, { ...BASE, page: 104_400 }, { ...LIMITS, page: 104_340 });
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'page', need: 104_438, allowed: 104_340, measured: 104_400 }]
		});
	});
});

describe('suggestRaise', () => {
	// A real refusal: 254,060 B needs 254,107 B against a limit of 253,668 B.
	it('asks for the shortfall over the approved limit, rounded up to 10 B', () => {
		const refusal = {
			line: 'precacheBytes' as const,
			need: 254_107,
			allowed: 254_098,
			measured: 254_060
		};
		expect(suggestRaise(BAND, refusal)).toBe(440);
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
