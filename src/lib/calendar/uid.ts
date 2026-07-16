/**
 * Stable, opaque per-task iCalendar UID: a deterministic SHA-256 over the taskId, hex-encoded,
 * suffixed with a FIXED namespace. Stable per task so a re-import UPDATES rather than duplicates
 * (well-behaved calendar apps dedup by UID). The namespace MUST NEVER change (changing it changes
 * every UID -> duplicate events on the next import); it is an RFC-5545 uniqueness qualifier, not a
 * resolvable domain. (Google two-way events use a separate calendar-scoped ref, not this UID.)
 */
const UID_NAMESPACE = 'mtc.local'; // STABLE - never change

export async function computeIcsUid(taskId: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(taskId));
	const hex = Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
	return `${hex}@${UID_NAMESPACE}`;
}
