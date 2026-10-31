/**
 * How a member is leaving: the optional answer that turns on the timeline steps for their path. "Not sure yet"
 * is not a value - choosing it stores nothing, so it reads the same as no answer.
 */
export const SEPARATION_PATHS = ['ets', 'retirement', 'medical', 'reserve-component'] as const;

export type SeparationPath = (typeof SEPARATION_PATHS)[number];

/** Each path in the words the setup question and the Settings row show. */
export const SEPARATION_PATH_LABEL: Record<SeparationPath, string> = {
	ets: 'Finishing my service',
	retirement: 'Retiring',
	medical: 'A medical board',
	'reserve-component': 'Leaving the Guard or Reserve'
};

/** The stored text as a path, or undefined for no answer or a value this release does not know. */
export function parseSeparationPath(s: string | undefined): SeparationPath | undefined {
	return (SEPARATION_PATHS as readonly string[]).includes(s ?? '')
		? (s as SeparationPath)
		: undefined;
}
