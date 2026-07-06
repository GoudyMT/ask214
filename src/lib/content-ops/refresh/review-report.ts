import type { ChangeRecord } from './classify-change';
import type { BlockDiff } from './diff-blocks';

export type RunbookSpec = { downloadHow: string; placementPath: string };

export type ReviewInput = ChangeRecord & {
	url: string;
	scrapeMethod: string;
	updateCheck: string;
	diff?: BlockDiff;
	stagedPath?: string;
	runbook?: RunbookSpec;
};

export type PendingSource = {
	sourceId: string;
	status: ChangeRecord['status'];
	oldHash: string;
	newHash?: string;
	stagedPath?: string;
	decision: 'pending' | 'approved';
};

export type PendingManifest = { generatedAt: string; sources: PendingSource[] };

export type ReviewReport = { markdown: string; manifest: PendingManifest };

function renderDiff(diff: BlockDiff | undefined): string {
	if (!diff) return '';
	const rem = diff.removed.map((b) => `- ${b}`);
	const add = diff.added.map((b) => `+ ${b}`);
	return [...rem, ...add].join('\n');
}

function renderRunbook(input: ReviewInput): string {
	const r = input.runbook;
	if (!r) return '';
	return [
		`1. Reference: ${input.url}  (cadence: ${input.updateCheck})`,
		`2. Download: ${r.downloadHow}`,
		`3. Placement: ${r.placementPath}`,
		`4. Ingest: pnpm ingest ${input.sourceId} -> pnpm chunk ${input.sourceId} -> pnpm embed`,
		`5. Verify: pnpm eval (must clear the floor) + re-confirm 17 USC 105 status`
	].join('\n');
}

function renderSource(input: ReviewInput): string {
	const lines = [
		`## ${input.sourceId} (${input.status})`,
		`${input.reason}.`,
		`hash: ${input.oldHash} -> ${input.newHash ?? '(unfetched)'}`
	];
	if (input.status === 'changed') {
		lines.push('', '### Delta', renderDiff(input.diff));
		lines.push(
			'',
			'### 17 USC 105 re-verification',
			'- [ ] Does this update insert third-party / copyrighted content (a CareerScope-style insert)?',
			'- [ ] Is the source still a US-Government public-domain work?',
			`- [ ] Approve with: pnpm refresh --approve ${input.sourceId}`
		);
	}
	if (input.status === 'manual-check-required') {
		lines.push('', '### Manual-check runbook', renderRunbook(input));
	}
	return lines.join('\n');
}

export function buildReviewReport(inputs: ReviewInput[], buildDate: string): ReviewReport {
	const changed = inputs.filter((i) => i.status === 'changed').length;
	const manual = inputs.filter((i) => i.status === 'manual-check-required').length;
	const markdown = [
		`# Corpus refresh review - ${buildDate}`,
		`${changed} changed, ${manual} manual-check-required.`,
		...inputs.map(renderSource)
	].join('\n\n');

	const manifest: PendingManifest = {
		generatedAt: buildDate,
		sources: inputs.map((i) => {
			const s: PendingSource = {
				sourceId: i.sourceId,
				status: i.status,
				oldHash: i.oldHash,
				decision: 'pending'
			};
			if (i.newHash !== undefined) s.newHash = i.newHash;
			if (i.stagedPath !== undefined) s.stagedPath = i.stagedPath;
			return s;
		})
	};
	return { markdown, manifest };
}
