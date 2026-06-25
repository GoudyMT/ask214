import { parseDocument, isMap, isSeq } from 'yaml';
import { resolveBackfill, backfillCaptureFields } from '../../src/lib/content-ops/capture/backfill';

/** Per-source fresh capture results, keyed by source_id: the content hash + its content type. */
export type IncomingBySourceId = Record<
	string,
	{ contentHash: string; contentType: 'pdf' | 'html' }
>;

/**
 * Stamp the A2 capture fields onto matching `sources.yaml` entries WITHOUT disturbing the file's comments
 * (the legal-record header + any per-entry notes). It edits the parsed Document's nodes in place and
 * re-serializes, instead of parse -> object -> stringify, which would drop every comment. Idempotent via
 * `resolveBackfill`: re-running with unchanged hashes is a byte-for-byte no-op. `now` is injected so the
 * stamp is deterministic. Pure (text in, text out); the orchestrator owns the IO + the fail-closed gates.
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
	}
	return doc.toString();
}
