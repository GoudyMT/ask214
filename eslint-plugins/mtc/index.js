/**
 * MTC project-local ESLint plugin.
 *
 * Rules enforce architectural invariants from the Phase 2 spec:
 * - section 4: encryption-boundary discipline (encrypted-store-registry)
 * - section 11: privacy boundaries, no PII in logs/errors (safelog-no-error,
 *   no-input-in-error)
 *
 * Each rule lives in `rules/<rule-name>.js` and is registered in `rules` below.
 */
export default {
	meta: {
		name: 'mtc',
		version: '0.1.0'
	},
	rules: {
		// Registered as each rule is implemented.
	},
	configs: {}
};
