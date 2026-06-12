/** Opaque Ask error codes (mtc/no-input-in-error; never interpolate input). */
export const ASK_ERROR = {
	MODEL_LOAD: 'E_ASK_MODEL_LOAD',
	EMBED: 'E_ASK_EMBED',
	CORPUS: 'E_ASK_CORPUS'
} as const;

export type AskErrorCode = (typeof ASK_ERROR)[keyof typeof ASK_ERROR];

/** Typed Ask failure carrying a static opaque code (mirrors B's error classes). */
export class AskError extends Error {
	readonly code: AskErrorCode;
	constructor(code: AskErrorCode) {
		super(code);
		this.name = 'AskError';
		this.code = code;
	}
}
