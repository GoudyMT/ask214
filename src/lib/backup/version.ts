/**
 * Version strings of the plain x.y.z form package.json carries. A backup file names the app version that made it,
 * and the app compares that with its own to tell "this file is from a newer app: update" from "this file is
 * damaged". No pre-release or build suffix is allowed, so there is no precedence rule to get wrong.
 */

// Each part is 0 or a non-zero digit followed by up to five digits, so the whole string is at most 20 characters.
const APP_VERSION_SHAPE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;

export function isAppVersion(v: unknown): v is string {
	return typeof v === 'string' && APP_VERSION_SHAPE.test(v);
}

/** Part by part as numbers, so 1.10.0 is later than 1.9.0. Both strings must pass isAppVersion. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
		const x = left[i] ?? 0;
		const y = right[i] ?? 0;
		if (x !== y) return x < y ? -1 : 1;
	}
	return 0;
}
