import { describe, it, expect } from 'vitest';
import { validatePlacement } from './placement';

describe('validatePlacement', () => {
	it('passes when every manual source has its expected staged file present', () => {
		const result = validatePlacement(
			[
				{ sourceId: 'tsp_separation', expectedPath: 'content-ops/staged/tsp.pdf' },
				{ sourceId: 'dol_manual', expectedPath: 'content-ops/staged/manual-html/dol_manual.html' }
			],
			new Set(['content-ops/staged/tsp.pdf', 'content-ops/staged/manual-html/dol_manual.html'])
		);
		expect(result).toEqual({ ok: true, missing: [] });
	});

	it('fails closed and names each missing/misnamed staged file', () => {
		const result = validatePlacement(
			[
				{ sourceId: 'tsp_separation', expectedPath: 'content-ops/staged/tsp.pdf' },
				{ sourceId: 'dol_manual', expectedPath: 'content-ops/staged/manual-html/dol_manual.html' }
			],
			new Set(['content-ops/staged/manual-html/dol_manual.html'])
		);
		expect(result.ok).toBe(false);
		expect(result.missing).toEqual([
			{ sourceId: 'tsp_separation', expectedPath: 'content-ops/staged/tsp.pdf' }
		]);
	});

	it('passes vacuously when there are no manual sources', () => {
		expect(validatePlacement([], new Set())).toEqual({ ok: true, missing: [] });
	});
});
