// Apply a plan's approved size band from measurement: `pnpm size:band apply --reason "<what grew>"`, and at the PR's
// final gate `pnpm size:band final`. The working standards' "One request, two checks" is the rule; the arithmetic and
// the file edits are in src/lib/ci/size-band-policy.ts. The band file is written when the owner approves the plan:
// { plan, approved, base: main's measured sizes, limit: the limits then, raise: { line: bytes } }.
//
// It builds the app (stop any preview first: a build replaces the files it serves), measures every budget line on
// each build with the two size checks themselves, and takes the highest. Inside the band it writes the new limits and
// a record line; past the band it writes nothing and exits 1 with the numbers for a re-request. It never commits, and
// it cannot do the trim pass (steps 1-2): run that first.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import {
	BUDGET_LINES,
	highest,
	isRecordReason,
	parseBand,
	planApply,
	planFinal,
	readLimits,
	rewriteLimits,
	suggestRaise
} from '../src/lib/ci/size-band-policy.ts';

const BUDGET_SCRIPT = 'content-ops/check-chunk-budget.mjs';
const PACKAGE_JSON = 'package.json';
const DEFAULT_BAND = '.claude/size-band.json';
const DEFAULT_BUILDS = 1;

/**
 * Run a node script and return what it printed, even when it exits non-zero (an over-budget check still prints).
 *
 * @param {string[]} args
 * @returns {string}
 */
function node(args) {
	try {
		return execFileSync(process.execPath, args, {
			encoding: 'utf8',
			maxBuffer: 64 * 1024 * 1024,
			// An over-budget check also prints its stack to stderr; the sizes line on stdout is all that is read.
			stdio: 'pipe'
		});
	} catch (error) {
		const failed = /** @type {{ stdout?: string }} */ (error);
		return failed.stdout ?? '';
	}
}

/**
 * Build once and read every budget line from the two checks' own output.
 *
 * @returns {import('../src/lib/ci/size-band-policy.ts').Sizes}
 */
function measureOneBuild() {
	// The fixed build version CI and the gate measure with, so the limits written here hold there.
	execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], {
		stdio: 'ignore',
		env: { ...process.env, MEASURE_BUILD: '1' }
	});
	const sizeLimit = JSON.parse(
		node(['node_modules/size-limit/bin.js', '--json']).replace(/^[^[]*/, '')
	);
	const named = (/** @type {string} */ start) =>
		sizeLimit.find((/** @type {{ name: string }} */ row) => row.name.startsWith(start))?.size;
	const chunks = node(['node_modules/tsx/dist/cli.mjs', BUDGET_SCRIPT]).match(
		/^ {4}sizes (\{.*\})$/m
	);
	if (chunks === null) throw new Error('E_SIZE_BAND_NO_SIZES');
	const sizes = {
		...JSON.parse(chunks[1] ?? ''),
		routeNodes: named('Lazy route nodes'),
		rootLayout: named('Root layout node')
	};
	// Every budget line by name: a size the check stopped printing is missing from `sizes`, not undefined in it.
	for (const line of BUDGET_LINES)
		if (!Number.isInteger(sizes[line])) {
			console.log(`    No size read for ${line}`);
			throw new Error('E_SIZE_BAND_NO_SIZES');
		}
	return sizes;
}

/** @param {string} flag */
function option(flag) {
	const at = process.argv.indexOf(flag);
	return at === -1 ? undefined : process.argv[at + 1];
}

function main() {
	const mode = process.argv[2];
	const reason = option('--reason') ?? (mode === 'final' ? 'end check' : undefined);
	const builds = Number(option('--builds') ?? DEFAULT_BUILDS);
	if ((mode !== 'apply' && mode !== 'final') || reason === undefined || !(builds >= 1)) {
		console.log(
			'Usage: size:band apply --reason "<what grew>" | final  [--band <file>] [--builds <n, at least 1>]'
		);
		process.exit(2);
	}

	console.log('='.repeat(60));
	console.log(`SIZE BAND (${mode.toUpperCase()})`);
	console.log('='.repeat(60));

	// Step 1: read and check everything before any build or write.
	console.log('\n[1/4] Reading the band and the current limits...');
	if (!isRecordReason(reason)) {
		console.log('    The reason must be one line of plain ASCII text with no $ sign.');
		process.exit(2);
	}
	const band = parseBand(JSON.parse(readFileSync(option('--band') ?? DEFAULT_BAND, 'utf8')));
	const script = readFileSync(BUDGET_SCRIPT, 'utf8');
	const packageJson = readFileSync(PACKAGE_JSON, 'utf8');
	const current = readLimits(script, packageJson);
	console.log(`    Plan: ${band.plan} (approved ${band.approved})`);

	// Step 2: measure the builds asked for; the highest of each line sets its limit.
	console.log(`\n[2/4] Building and measuring ${builds} time(s)...`);
	const runs = [];
	for (let i = 0; i < builds; i += 1) {
		runs.push(measureOneBuild());
		console.log(`    Build ${i + 1}: ${JSON.stringify(runs[i])}`);
	}
	const measured = highest(runs);

	// Step 3: plan the changes; one refusal stops them all.
	console.log('\n[3/4] Checking against the band...');
	const plan = (mode === 'apply' ? planApply : planFinal)(band, measured, current);
	if (!plan.ok) {
		for (const r of plan.refusals)
			console.log(
				`    REFUSED ${r.line}: needs ${r.need.toLocaleString('en-US')} B, allowed ${r.allowed.toLocaleString('en-US')} B (measured ${r.measured.toLocaleString('en-US')} B, ${(r.need - r.allowed).toLocaleString('en-US')} B short)`
			);
		if (mode === 'apply')
			for (const r of plan.refusals)
				console.log(
					`    Re-request ${r.line}: +${suggestRaise(band, r)} B (the need over the approved limit)`
				);
		console.log(
			'\nNothing written. Run a trim pass; if it finds too little, re-request from these numbers.'
		);
		process.exit(1);
	}
	for (const c of plan.changes)
		console.log(
			`    ${c.line}: ${c.from.toLocaleString('en-US')} -> ${c.to.toLocaleString('en-US')} (measured ${c.measured.toLocaleString('en-US')} B, margin ${c.margin} B)`
		);
	if (plan.changes.length === 0) {
		console.log('    No limit needs to change.');
		return;
	}

	// Step 4: write both files only after both texts were built.
	console.log('\n[4/4] Writing the limits and their record...');
	const date = new Date().toLocaleDateString('en-CA');
	const next = rewriteLimits(script, packageJson, plan.changes, { date, reason });
	writeFileSync(BUDGET_SCRIPT, next.script);
	writeFileSync(PACKAGE_JSON, next.packageJson);
	console.log(
		`    Written: ${BUDGET_SCRIPT}, ${PACKAGE_JSON}. Commit them as their own chore: commit.`
	);
}

main();
