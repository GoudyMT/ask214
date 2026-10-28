import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	highest,
	marginFor,
	parseBand,
	planApply,
	planFinal,
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

	it('refuses a raise on a line the band does not list', () => {
		const plan = planApply(BAND, { ...BASE, rootLayout: 9_800 }, LIMITS);
		expect(plan).toEqual({
			ok: false,
			changes: [],
			refusals: [{ line: 'rootLayout', need: 9_840, allowed: 9_820, measured: 9_800 }]
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

describe('parseBand', () => {
	it('refuses a band file that lacks a line or holds a negative raise', () => {
		expect(() => parseBand({ ...BAND, base: { ...BASE, page: undefined } })).toThrow(
			'E_SIZE_BAND_FILE'
		);
		expect(() => parseBand({ ...BAND, raise: { page: -1 } })).toThrow('E_SIZE_BAND_FILE');
		expect(() => parseBand({ ...BAND, raise: { precacheFiles: 1 } })).toThrow('E_SIZE_BAND_FILE');
	});
});

describe('rewriteLimits on the real budget files', () => {
	const changes = [
		{
			line: 'page' as const,
			from: LIMITS.page,
			to: 104_340,
			measured: 104_300,
			growth: 271,
			margin: 40
		},
		{
			line: 'routeNodes' as const,
			from: LIMITS.routeNodes,
			to: 59_890,
			measured: 59_850,
			growth: 41,
			margin: 40
		}
	];
	const current = readLimits(BUDGET_SCRIPT, PACKAGE_JSON);
	const realChanges = changes.map((c) => ({ ...c, from: current[c.line] }));
	const out = rewriteLimits(BUDGET_SCRIPT, PACKAGE_JSON, realChanges, {
		date: '2026-10-28',
		reason: 'the money tools links'
	});

	it('writes the new limits where both checks read them', () => {
		const limits = readLimits(out.script, out.packageJson);
		expect(limits.page).toBe(104_340);
		expect(limits.routeNodes).toBe(59_890);
		expect(limits.onDemand).toBe(current.onDemand);
		const sizeLimit = JSON.parse(out.packageJson)['size-limit'] as {
			name: string;
			limit: string;
		}[];
		expect(sizeLimit.find((e) => e.name.startsWith('Lazy route nodes'))?.limit).toBe('59890 B');
	});

	it('changes only the limit lines and adds only comment lines, so no code beside them moves', () => {
		const before = BUDGET_SCRIPT.split('\n');
		const after = out.script.split('\n');
		const added = after.filter((line) => !before.includes(line));
		const removed = before.filter((line) => !after.includes(line));
		expect(removed).toEqual([
			`\tpage: ${current.page.toLocaleString('en-US').replaceAll(',', '_')},`
		]);
		expect(added.filter((line) => !line.startsWith('//'))).toEqual(['\tpage: 104_340,']);
		const record = `page ${current.page.toLocaleString('en-US')} -> 104,340`;
		expect(added.some((line) => line.startsWith('//') && line.includes(record))).toBe(true);
		const pkgBefore = PACKAGE_JSON.split('\n');
		const pkgChanged = out.packageJson.split('\n').filter((line, i) => line !== pkgBefore[i]);
		expect(pkgChanged).toEqual(['\t\t\t"limit": "59890 B",']);
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
