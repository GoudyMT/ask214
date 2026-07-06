import type { PendingManifest } from './review-report';

// The approval gate: nothing re-ships without an explicit --approve. An unknown id is a static opaque code
// (mtc/no-input-in-error - never interpolate the id into the Error).
export function applyApproval(manifest: PendingManifest, approvedIds: string[]): PendingManifest {
	const known = new Set(manifest.sources.map((s) => s.sourceId));
	for (const id of approvedIds) {
		if (!known.has(id)) throw new Error('E_REFRESH_UNKNOWN_SOURCE');
	}
	const approve = new Set(approvedIds);
	return {
		generatedAt: manifest.generatedAt,
		sources: manifest.sources.map((s) =>
			approve.has(s.sourceId) ? { ...s, decision: 'approved' as const } : s
		)
	};
}
