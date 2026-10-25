/**
 * Fetches the code the PIN setup runs on Next: the derive's page side (in the PIN card's file), the move of every record
 * onto the new keys, and the derive's settings. Settings shows the row at once and asks for this only when someone sets
 * a PIN, so a visit that never does downloads none of it.
 */
export const loadAppLock = () =>
	Promise.all([
		import('./load-pin-code'),
		import('../keystore/rotate'),
		import('../backup/kdf-params')
	]);
