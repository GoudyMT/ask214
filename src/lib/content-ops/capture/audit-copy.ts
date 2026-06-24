import { sha256Hex } from './hash';

/**
 * The internal audit-copy record (A2-D5): the content-addressed path + integrity fields for a captured
 * original. NEVER served. The `content_hash` is the legal-audit fingerprint AND the idempotency /
 * A5-update-detection signal; the path is content-addressed so the audit copy is immutable. The file
 * extension equals the content type (`pdf` | `html`). Pure: the actual file write is the build script.
 */
export type CaptureRecord = { contentHash: string; capturedPath: string; byteSize: number };

export async function auditCopyRecord(
	bytes: Uint8Array,
	contentType: 'pdf' | 'html'
): Promise<CaptureRecord> {
	const contentHash = await sha256Hex(bytes);
	return {
		contentHash,
		capturedPath: `content-ops/captures/${contentHash}.${contentType}`,
		byteSize: bytes.byteLength
	};
}
