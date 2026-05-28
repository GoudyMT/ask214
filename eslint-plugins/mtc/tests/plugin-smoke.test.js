import { describe, it, expect } from 'vitest';
import plugin from '../index.js';

describe('mtc ESLint plugin scaffold', () => {
	it('exposes the mtc namespace with expected rule names registered', () => {
		expect(plugin).toBeDefined();
		expect(plugin.meta?.name).toBe('mtc');
		expect(plugin.rules).toBeDefined();
		// Rules added in subsequent tasks register their entries here; this
		// task only verifies the scaffold is in place.
		expect(typeof plugin.rules).toBe('object');
	});
});
