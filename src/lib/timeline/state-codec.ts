import type { TimelineState } from './types';

/**
 * Timeline-state encoding for AES-GCM input. Unlike the profile codec there are no
 * Uint8Array fields (status / snoozeUntil / notes are all JSON-native), so this is a
 * plain JSON encode - no base64, and no key-sorting (nothing hashes the plaintext, so
 * deterministic encoding is unnecessary here). schemaVersion lives INSIDE the encrypted
 * JSON and is checked by decode AFTER AES-GCM authentication (no plaintext header).
 */
const SCHEMA_VERSION = 1;

export class TimelineSchemaError extends Error {
	constructor() {
		super('E_TIMELINE_SCHEMA');
		this.name = 'TimelineSchemaError';
	}
}

export function encodeTimelineState(state: TimelineState): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(state));
}

export function decodeTimelineState(bytes: Uint8Array): TimelineState {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new TimelineSchemaError();
	}
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		(parsed as { schemaVersion?: unknown }).schemaVersion !== SCHEMA_VERSION
	) {
		throw new TimelineSchemaError();
	}
	return parsed as TimelineState;
}
