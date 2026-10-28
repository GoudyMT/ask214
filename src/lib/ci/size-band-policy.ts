// The size band: a plan's one approved budget raise, applied from measurement and never past what was approved.
// "Size Budgets: Trim Before You Ask" -> "One request, two checks" in the working standards is the rule; this module
// is the arithmetic and the file edits, so neither is done by hand. content-ops/apply-size-band.mjs runs it.

/** Every budget line the two size checks enforce: check-chunk-budget.mjs's LIMIT and package.json's size-limit. */
export const BUDGET_LINES = [
	'page',
	'onDemand',
	'precacheFiles',
	'precacheBytes',
	'workerScripts',
	'routeNodes',
	'rootLayout'
] as const;

export type BudgetLine = (typeof BUDGET_LINES)[number];
export type Sizes = Record<BudgetLine, number>;

/** A count, not bytes: a byte margin means nothing for it, so the script never raises or lowers it. */
const COUNT_LINES: ReadonlySet<BudgetLine> = new Set(['precacheFiles']);

/**
 * Where each limit is written: check-chunk-budget.mjs's LIMIT, or package.json's size-limit entry found by its name.
 * Each pattern is a literal, built fresh per use (a global RegExp carries its position between calls). The last LIMIT
 * entry has no trailing comma, so the comma is captured and kept as found.
 */
const LIMIT_AT: Record<BudgetLine, { file: 'script' | 'package'; pattern: () => RegExp }> = {
	page: { file: 'script', pattern: () => /^\tpage: ([\d_]+)(,?)$/gm },
	onDemand: { file: 'script', pattern: () => /^\tonDemand: ([\d_]+)(,?)$/gm },
	precacheFiles: { file: 'script', pattern: () => /^\tprecacheFiles: ([\d_]+)(,?)$/gm },
	precacheBytes: { file: 'script', pattern: () => /^\tprecacheBytes: ([\d_]+)(,?)$/gm },
	workerScripts: { file: 'script', pattern: () => /^\tworkerScripts: ([\d_]+)(,?)$/gm },
	routeNodes: {
		file: 'package',
		pattern: () =>
			/("name": "Lazy route nodes \(sum; no single page loads all of them\)",\n\t+"path": "[^"\n]*",\n\t+"limit": ")(\d+) B(")/g
	},
	rootLayout: {
		file: 'package',
		pattern: () =>
			/("name": "Root layout node \(loaded on every page\)",\n\t+"path": "[^"\n]*",\n\t+"limit": ")(\d+) B(")/g
	}
};

export type Band = {
	plan: string;
	approved: string;
	/** `main`'s measured sizes when the band was asked, so growth is counted from where the plan started. */
	base: Sizes;
	/** The limits when the band was approved: a raise is counted from these. */
	limit: Sizes;
	/** The approved raise per byte line, in bytes; a line not listed may not be raised. */
	raise: Partial<Record<BudgetLine, number>>;
};

export type Change = {
	line: BudgetLine;
	from: number;
	to: number;
	measured: number;
	growth: number;
	margin: number;
	/** Bytes past the approved band, applied under the standing allowance and reported rather than asked. */
	overBand?: number;
};
export type Refusal = { line: BudgetLine; need: number; allowed: number; measured: number };
export type Plan =
	{ ok: true; changes: Change[] } | { ok: false; changes: []; refusals: Refusal[] };

/**
 * The room a limit keeps above its measured size: 10% of the growth or 40 B, whichever is larger.
 *
 * 40 B because builds of the same code differ by up to ~25 B between commits (a time-stamped chunk renames every
 * file that imports it), so a smaller room fails CI on noise.
 */
export function marginFor(growth: number): number {
	return Math.max(40, Math.ceil(Math.max(0, growth) * 0.1));
}

/**
 * How far past its band a line may go and still be applied without asking (the owner's standing allowance): 50 B, or
 * 10% of the band when that is larger. A band is asked from two builds, and the same code has measured up to ~30 B
 * apart between builds, so an overrun this small is build drift, not new code; it is applied and reported. A line
 * with no band gets none, and the end check lowers whatever room is left, so the allowance cannot pile up.
 */
export function allowanceFor(raise: number): number {
	return Math.max(50, Math.ceil(raise * 0.1));
}

/** Each line's largest size across several builds of the same code, so a lucky small build never sets a limit. */
export function highest(builds: Sizes[]): Sizes {
	const out = { ...builds[0] } as Sizes;
	for (const build of builds)
		for (const line of BUDGET_LINES) out[line] = Math.max(out[line], build[line]);
	return out;
}

/**
 * Read and check a band file's contents.
 *
 * @throws Error `E_SIZE_BAND_FILE` when a line is missing or not a whole number, or a raise is negative or names a
 *   count line. A band read wrong would let the script raise past what was approved.
 */
export function parseBand(value: unknown): Band {
	const fail = () => {
		throw new Error('E_SIZE_BAND_FILE');
	};
	const band = value as Band;
	const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 0;
	if (typeof band?.plan !== 'string' || typeof band.approved !== 'string') fail();
	for (const key of ['base', 'limit'] as const)
		for (const line of BUDGET_LINES) if (!whole(band[key]?.[line])) fail();
	for (const [line, bytes] of Object.entries(band.raise ?? fail())) {
		const known = (BUDGET_LINES as readonly string[]).includes(line);
		if (!known || COUNT_LINES.has(line as BudgetLine) || !whole(bytes)) fail();
	}
	return band;
}

function refuseOrChange(plan: { changes: Change[]; refusals: Refusal[] }): Plan {
	return plan.refusals.length > 0
		? { ok: false, changes: [], refusals: plan.refusals }
		: { ok: true, changes: plan.changes };
}

/**
 * The raise for this build: each line over (or within its margin of) its limit goes to its size plus the margin,
 * when that fits the band. One line past its band refuses the whole plan, so nothing is written that a re-request
 * from the measurement would have to undo.
 */
export function planApply(band: Band, measured: Sizes, current: Sizes): Plan {
	const changes: Change[] = [];
	const refusals: Refusal[] = [];
	for (const line of BUDGET_LINES) {
		const size = measured[line];
		if (COUNT_LINES.has(line)) {
			if (size > current[line])
				refusals.push({ line, need: size, allowed: current[line], measured: size });
			continue;
		}
		const growth = size - band.base[line];
		const margin = marginFor(growth);
		const need = size + margin;
		if (need <= current[line]) continue;
		const raise = band.raise[line] ?? 0;
		const allowed = band.limit[line] + raise;
		const change = { line, from: current[line], to: need, measured: size, growth, margin };
		if (need <= allowed) changes.push(change);
		else if (raise > 0 && need <= allowed + allowanceFor(raise))
			changes.push({ ...change, overBand: need - allowed });
		else refusals.push({ line, need, allowed, measured: size });
	}
	return refuseOrChange({ changes, refusals });
}

/**
 * The end check, after the sweep's fixes: a band line with more room than its margin is lowered to its size plus
 * the margin; any line over its limit fails, back to a trim pass (a raise past the band is the owner's call).
 */
export function planFinal(band: Band, measured: Sizes, current: Sizes): Plan {
	const changes: Change[] = [];
	const refusals: Refusal[] = [];
	for (const line of BUDGET_LINES) {
		const size = measured[line];
		const growth = size - band.base[line];
		const margin = COUNT_LINES.has(line) ? 0 : marginFor(growth);
		if (size > current[line]) {
			refusals.push({ line, need: size + margin, allowed: current[line], measured: size });
			continue;
		}
		if (!(line in band.raise) || current[line] - size <= margin) continue;
		changes.push({ line, from: current[line], to: size + margin, measured: size, growth, margin });
	}
	return refuseOrChange({ changes, refusals });
}

/** The most two local builds of the same code have been measured apart (41 B; CI's spread was ~25 B). */
const DRIFT_BYTES = 40;

/**
 * The raise to re-request for a refused line: what this build needs over the approved limit, plus the drift the next
 * build may add, rounded up to 10 B. A band set at exactly the measured need fails the next build on drift alone.
 */
export function suggestRaise(band: Band, refusal: Refusal): number {
	return Math.ceil((refusal.need - band.limit[refusal.line] + DRIFT_BYTES) / 10) * 10;
}

const RECORD_ANCHOR =
	'// Raise a limit only with a measured reason recorded here; never to make a run pass.';
const RECORD_LINE = () =>
	/^\/\/ Raise a limit only with a measured reason recorded here; never to make a run pass\.$/gm;

function exactlyOne(source: string, pattern: RegExp): RegExpMatchArray {
	const matches = [...source.matchAll(pattern)];
	if (matches.length !== 1) throw new Error('E_SIZE_BAND_ANCHOR');
	return matches[0] as RegExpMatchArray;
}

/**
 * The current limits, read where the two checks read them.
 *
 * @throws Error `E_SIZE_BAND_ANCHOR` when a limit is not found exactly once.
 */
export function readLimits(script: string, packageJson: string): Sizes {
	const out = {} as Sizes;
	for (const line of BUDGET_LINES) {
		const { file, pattern } = LIMIT_AT[line];
		out[line] =
			file === 'script'
				? Number((exactlyOne(script, pattern())[1] as string).replaceAll('_', ''))
				: Number(exactlyOne(packageJson, pattern())[2]);
	}
	return out;
}

const grouped = (n: number, separator: string) =>
	n.toLocaleString('en-US').replaceAll(',', separator);

/**
 * Both files with the changes written: each limit number in place, and one dated record line per change above the
 * script's limits. Every anchor is found before either text is changed, so a miss changes nothing.
 *
 * @throws Error `E_SIZE_BAND_ANCHOR` when a limit or the record anchor is not found exactly once.
 */
export function rewriteLimits(
	script: string,
	packageJson: string,
	changes: Change[],
	record: { date: string; reason: string }
): { script: string; packageJson: string } {
	exactlyOne(script, RECORD_LINE());
	for (const { line } of changes) {
		const { file, pattern } = LIMIT_AT[line];
		exactlyOne(file === 'script' ? script : packageJson, pattern());
	}
	let nextScript = script;
	let nextPackage = packageJson;
	for (const { line, to } of changes) {
		const { file, pattern } = LIMIT_AT[line];
		if (file === 'script')
			nextScript = nextScript.replace(pattern(), `\t${line}: ${grouped(to, '_')}$2`);
		else nextPackage = nextPackage.replace(pattern(), `$1${to} B$3`);
	}
	const lines = changes.map(
		(c) =>
			`//   ${record.date} ${record.reason}: ${c.line} ${grouped(c.from, ',')} -> ${grouped(c.to, ',')} ` +
			`(measured ${grouped(c.measured, ',')} B, ${c.growth >= 0 ? '+' : ''}${grouped(c.growth, ',')} B on the plan's base, margin ${c.margin} B` +
			(c.overBand === undefined
				? ').'
				: `; ${c.overBand} B past the band, under the standing allowance).`)
	);
	if (lines.length > 0)
		nextScript = nextScript.replace(RECORD_ANCHOR, `${lines.join('\n')}\n//\n${RECORD_ANCHOR}`);
	return { script: nextScript, packageJson: nextPackage };
}
