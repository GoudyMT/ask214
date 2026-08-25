import { describe, it, expect, beforeEach } from 'vitest';
import { stashRoute, readStashedRoute } from './context';

describe('route context stash', () => {
	beforeEach(() => sessionStorage.clear());
	it('stashes a known route and reads it back once', () => {
		stashRoute('/timeline');
		expect(readStashedRoute()).toBe('/timeline');
		expect(readStashedRoute()).toBeNull(); // cleared after read
	});
	it('does not stash an unknown route', () => {
		stashRoute('/evil');
		expect(readStashedRoute()).toBeNull();
	});
	it('reads null when nothing stashed', () => {
		expect(readStashedRoute()).toBeNull();
	});
});
