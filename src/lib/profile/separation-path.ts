/**
 * How a member is leaving: the optional answer that turns on the timeline steps for their path. "Not sure yet"
 * is not a value - choosing it stores nothing, so it reads the same as no answer.
 */
export const SEPARATION_PATHS = [
	'ets',
	'retirement',
	'reserve-retirement',
	'medical',
	'reserve-component'
] as const;

export type SeparationPath = (typeof SEPARATION_PATHS)[number];

/** Each path in the words the setup question and the Settings row show. */
export const SEPARATION_PATH_LABEL: Record<SeparationPath, string> = {
	ets: 'Finishing my service',
	retirement: 'Retiring',
	'reserve-retirement': 'Retiring from the Guard or Reserve',
	medical: 'A medical board',
	'reserve-component': 'Leaving the Guard or Reserve'
};

// A default decoder drops a leading byte-order mark, which would let a second spelling of a known answer through.
const exactText = new TextDecoder('utf-8', { ignoreBOM: true });

/**
 * The stored bytes as a path, or undefined for no answer or a value this release does not know. The timeline, the
 * backup check and the export all read the answer here, so they agree on which bytes are one.
 */
export function parseSeparationPath(bytes: Uint8Array | undefined): SeparationPath | undefined {
	const s = bytes ? exactText.decode(bytes) : '';
	return (SEPARATION_PATHS as readonly string[]).includes(s) ? (s as SeparationPath) : undefined;
}
