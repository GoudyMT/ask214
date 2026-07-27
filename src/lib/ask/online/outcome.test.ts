import { describe, it, expect } from 'vitest';
import { mapOutcome } from './outcome';

describe('mapOutcome', () => {
	it('maps status:empty to no-source (the ONLY path that does)', () => {
		expect(mapOutcome({ status: 'empty' })).toBe('no_source');
	});
	it('maps a transport throw to service-unavailable, NEVER no-source', () => {
		expect(mapOutcome({ status: 'error' })).toBe('service_unavailable');
	});
	it('maps high_demand to degrade', () => {
		expect(mapOutcome({ status: 'high_demand' })).toBe('degrade');
	});
	it('maps results to render', () => {
		expect(mapOutcome({ status: 'results', results: [], corpusVersion: '1.0' })).toBe('render');
	});
});
