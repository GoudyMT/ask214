import { describe, it, expect } from 'vitest';
import { documentStates } from './document-states';

// Shaped like the generated map: real source ids and their current served paths.
const DOCUMENTS = {
	tap_vet_centers: '/docs/tap_vet_centers.1dcfd966.pdf',
	tap_va_home_loan: '/docs/tap_va_home_loan.1390c011.pdf'
};
// An older copy of tap_vet_centers, as a recapture leaves it in the cache.
const VET_OLD = '/docs/tap_vet_centers.0badc0de.pdf';

describe('documentStates', () => {
	it('reports a document whose current copy is held as saved, and one with nothing held as unsaved', () => {
		expect(documentStates(['/docs/tap_vet_centers.1dcfd966.pdf'], DOCUMENTS)).toEqual({
			tap_vet_centers: { state: 'saved', stale: [] },
			tap_va_home_loan: { state: 'unsaved', stale: [] }
		});
	});

	// Saving again or removing must clear the old copy too, so it is listed even when the current one is held.
	it('lists an older copy as stale even when the current copy is saved', () => {
		const states = documentStates(['/docs/tap_vet_centers.1dcfd966.pdf', VET_OLD], DOCUMENTS);
		expect(states['tap_vet_centers']).toEqual({ state: 'saved', stale: [VET_OLD] });
	});

	it('reports a document held only in an older copy as updated', () => {
		expect(documentStates([VET_OLD], DOCUMENTS)['tap_vet_centers']).toEqual({
			state: 'updated',
			stale: [VET_OLD]
		});
	});

	it('reports every document unsaved when nothing is held', () => {
		expect(documentStates([], DOCUMENTS)).toEqual({
			tap_vet_centers: { state: 'unsaved', stale: [] },
			tap_va_home_loan: { state: 'unsaved', stale: [] }
		});
	});

	it('ignores a held document this build does not ship', () => {
		const states = documentStates(['/docs/tap_retired_guide.1111aaaa.pdf'], DOCUMENTS);
		expect(Object.keys(states).sort()).toEqual(['tap_va_home_loan', 'tap_vet_centers']);
		expect(states['tap_vet_centers']?.state).toBe('unsaved');
	});

	// The source id is read by position after "/docs/", so a document-named file in another namespace of the
	// same length ("/wasm/") would read as that document without the namespace check.
	it('ignores held files outside the documents namespace', () => {
		const held = [
			'/models/Xenova/all-MiniLM-L6-v2/onnx/model_quantized.onnx',
			'/wasm/tap_vet_centers.1dcfd966.pdf'
		];
		expect(documentStates(held, DOCUMENTS)['tap_vet_centers']).toEqual({
			state: 'unsaved',
			stale: []
		});
	});
});
