/**
 * MTC project-local ESLint plugin.
 *
 * Rules enforce architectural invariants from the Phase 2 spec:
 * - section 4: encryption-boundary discipline (encrypted-store-registry, no-extractable-keys)
 * - section 11: privacy boundaries, no PII in logs/errors (safelog-no-error,
 *   no-input-in-error)
 *
 * Each rule lives in `rules/<rule-name>.js` and is registered in `rules` below.
 */
import safelogNoError from './rules/safelog-no-error.js';
import encryptedStoreRegistry from './rules/encrypted-store-registry.js';
import noInputInError from './rules/no-input-in-error.js';
import noExtractableKeys from './rules/no-extractable-keys.js';

export default {
	meta: {
		name: 'mtc',
		version: '0.1.0'
	},
	rules: {
		'safelog-no-error': safelogNoError,
		'encrypted-store-registry': encryptedStoreRegistry,
		'no-input-in-error': noInputInError,
		'no-extractable-keys': noExtractableKeys
	},
	configs: {}
};
