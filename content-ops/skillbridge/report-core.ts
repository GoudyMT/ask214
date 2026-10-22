/**
 * The report Max reads before he deploys: counts, static codes, file names and provider names, and nothing
 * else. It is built field by field from numbers and codes, never by copying a listing or a raw row, so a contact
 * email or name cannot reach it.
 */

import type { BuiltWeek } from './layout-core.ts';
import type { CheckOutput, CleanOutput, PullMode, PullOutcome, StopCode } from './types.ts';

export type RunReport = {
	pullDate: string;
	mode: PullMode;
	baseline: boolean;
	/** A stopped run: the rest is zero or empty. */
	stop?: StopCode;
	requests: number;
	elapsedMs: number;
	totalN: number;
	sumOfTotals: number;
	sumGate: boolean;
	/** The Filters total, shown beside `uniqueIds` (the rows the pull returned). */
	totalPositions: number;
	uniqueIds: number;
	providersQueried: number;
	providersIncomplete: number;
	cappedQueries: number;
	dormantSwept: boolean;
	quarantine: Record<string, number>;
	dropped: Record<string, number>;
	published: number;
	added: number;
	removed: number;
	notSeen: number;
	newOrgs: number;
	driftAbort: boolean;
	blockers: string[];
	floorWarnings: { provider: string; last: number; now: number }[];
	files: { name: string; count: number; bytes: number }[];
};

function countByCode(items: readonly { code: string }[]): Record<string, number> {
	const counts = new Map<string, number>();
	for (const { code } of items) counts.set(code, (counts.get(code) ?? 0) + 1);
	return Object.fromEntries(counts);
}

export function buildReport(input: {
	pull: PullOutcome;
	clean?: CleanOutput;
	check?: CheckOutput;
	week?: BuiltWeek;
	baseline: boolean;
	pullDate: string;
}): RunReport {
	const { pull, clean, check, week, baseline, pullDate } = input;
	// Nothing the pull never learned is invented: a stopped run reports zeros, and its stop code.
	const run = pull.ok ? pull.run : undefined;
	const providers = run?.providers ?? [];

	return {
		pullDate,
		mode: run?.mode ?? 'full',
		baseline,
		...(pull.ok ? {} : { stop: pull.stop }),
		requests: run?.requests ?? (pull.ok ? 0 : pull.requests),
		elapsedMs: run?.elapsedMs ?? (pull.ok ? 0 : pull.elapsedMs),
		totalN: run?.totalN ?? 0,
		sumOfTotals: run?.sumOfTotals ?? 0,
		sumGate: run?.sumGate ?? false,
		totalPositions: run?.totalPositions ?? 0,
		uniqueIds: run?.rows.length ?? 0,
		providersQueried: providers.length,
		providersIncomplete: providers.filter((p) => !p.complete).length,
		cappedQueries: providers.reduce((n, p) => n + p.cappedQueries, 0),
		dormantSwept: run?.dormantSwept ?? false,
		quarantine: countByCode(clean?.quarantine ?? []),
		dropped: { ...clean?.dropped },
		published: check?.published.length ?? 0,
		added: check?.week.added.length ?? 0,
		removed: check?.removed.length ?? 0,
		notSeen: check?.notSeen.length ?? 0,
		newOrgs: check?.week.newOrgs.length ?? 0,
		driftAbort: check?.driftAbort ?? false,
		blockers: [...new Set([...(check?.blockers ?? []), ...(week?.errors ?? [])])],
		floorWarnings: (check?.floorWarnings ?? []).map((w) => ({ ...w })),
		files: (week?.index.files ?? []).map((f) => ({ ...f }))
	};
}

// A provider name arrives from a server we do not run: any character, line breaks included. Anything outside
// printable ASCII becomes `?`, so the text stays plain and a name cannot start a line of its own.
const NOT_PRINTABLE_ASCII = /[^ -~]/g;
const safe = (s: string) => s.replace(NOT_PRINTABLE_ASCII, '?');

function tally(counts: Record<string, number>): string {
	const entries = Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return entries.length === 0
		? 'none'
		: entries.map(([code, n]) => `${safe(code)} ${n}`).join(', ');
}

/** Plain ASCII lines for Max to read. */
export function reportText(report: RunReport): string {
	const held = [...(report.stop === undefined ? [] : [report.stop]), ...report.blockers];
	const lines = [
		`SkillBridge weekly run, pull date ${safe(report.pullDate)} (${report.mode} pull${report.baseline ? ', baseline' : ''})`
	];
	if (report.stop !== undefined)
		lines.push(`STOPPED: ${safe(report.stop)}. Nothing from this run can be published.`);
	lines.push(
		`Requests: ${report.requests} in ${(report.elapsedMs / 1000).toFixed(1)} s`,
		`Pull: N ${report.totalN}; sum of provider totals ${report.sumOfTotals} (sum gate ${report.sumGate ? 'passed' : 'FAILED'}); site total ${report.totalPositions}; unique ids ${report.uniqueIds}`,
		`Providers: ${report.providersQueried} queried, ${report.providersIncomplete} not proven complete, ${report.cappedQueries} queries still capped, dormant sweep ${report.dormantSwept ? 'yes' : 'no'}`,
		`Quarantined rows: ${tally(report.quarantine)}`,
		`Dropped values: ${tally(report.dropped)}`,
		`Published ${report.published}: added ${report.added}, removed ${report.removed}, not seen ${report.notSeen}, new organizations ${report.newOrgs}`
	);
	for (const w of report.floorWarnings)
		lines.push(`Floor: ${safe(w.provider)} fell from ${w.last} to ${w.now}`);
	if (report.driftAbort) lines.push('Drift: additions or removals passed the limit.');
	lines.push('Files:');
	for (const f of report.files)
		lines.push(`  ${safe(f.name)}: ${f.count} listings, ${f.bytes} bytes`);
	lines.push(
		held.length > 0
			? `Publish: BLOCKED (${held.map(safe).join(', ')}). Do not deploy.`
			: 'Publish: clear. Read the numbers above, then deploy.'
	);
	return lines.join('\n') + '\n';
}
