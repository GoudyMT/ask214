import { describe, it, expect } from 'vitest';
import { nextRung } from './ladder';

describe('degradation ladder (terminal, no auto-follow)', () => {
	it('offers on-device when online fails and device is untried + capable', () => {
		expect(
			nextRung({ failed: new Set<'online' | 'device'>(['online']), deviceCapable: true })
		).toBe('offer_device');
	});
	it('routes to the outbound hub once BOTH paths have failed this session', () => {
		expect(
			nextRung({ failed: new Set<'online' | 'device'>(['online', 'device']), deviceCapable: true })
		).toBe('outbound_hub');
	});
	it('routes to the outbound hub when online failed and device is not capable', () => {
		expect(
			nextRung({ failed: new Set<'online' | 'device'>(['online']), deviceCapable: false })
		).toBe('outbound_hub');
	});
	it('offers online when only on-device has failed', () => {
		expect(
			nextRung({ failed: new Set<'online' | 'device'>(['device']), deviceCapable: true })
		).toBe('offer_online');
	});
	it('routes to the outbound hub when nothing has failed yet', () => {
		expect(nextRung({ failed: new Set<'online' | 'device'>(), deviceCapable: true })).toBe(
			'outbound_hub'
		);
	});
});
