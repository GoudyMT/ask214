import { parseDocument, isMap, isSeq } from 'yaml';
import {
	resolveBackfill,
	backfillCaptureFields,
	type IncomingCapture
} from '../../src/lib/content-ops/capture/backfill';

/** Per-source fresh capture results, keyed by source_id. */
export type IncomingBySourceId = Record<string, IncomingCapture>;

/**
 * Stamp the capture fields onto matching `sources.yaml` entries WITHOUT disturbing the file's comments
 * (the legal-record header + any per-entry notes). It edits the parsed Document's nodes in place and
 * re-serializes, instead of parse -> object -> stringify, which would drop every comment. Idempotent:
 * re-running with unchanged hashes is a byte-for-byte no-op. `now` is injected so the stamp is deterministic.
 * Pure (text in, text out); the caller owns the IO + the fail-closed gates.
 */
export function stampSourcesYaml(
	yamlText: string,
	incomingBySourceId: IncomingBySourceId,
	now: string
): string {
	const doc = parseDocument(yamlText);
	const root = doc.contents;
	const items = isSeq(root) ? root.items : [];
	for (const node of items) {
		if (!isMap(node)) continue;
		const sourceId = node.get('source_id');
		if (typeof sourceId !== 'string') continue;
		const incoming = incomingBySourceId[sourceId];
		if (!incoming) continue;
		const existing = {
			content_hash: node.get('content_hash'),
			captured_at: node.get('captured_at')
		};
		const fields = backfillCaptureFields({}, resolveBackfill(existing, incoming, now));
		for (const [key, value] of Object.entries(fields)) node.set(key, value);
		if (incoming.sourceUpdatedDate !== undefined)
			node.set('source_updated_date', incoming.sourceUpdatedDate);
	}
	// lineWidth 0 disables yaml's 80-col wrapping, so long scalars (e.g. terms_notes) are never re-folded -
	// the diff touches only the entries we actually stamp, keeping the legal-record change reviewable.
	return doc.toString({ lineWidth: 0 });
}
