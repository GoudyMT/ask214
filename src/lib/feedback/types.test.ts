import { describe, it, expect } from 'vitest';
import { sanitizeRoute, routeLabel } from './types';

describe('sanitizeRoute', () => {
	it('accepts a known app route', () => {
		expect(sanitizeRoute('/timeline')).toBe('/timeline');
		expect(sanitizeRoute('/')).toBe('/');
	});
	it('strips query and hash before matching', () => {
		expect(sanitizeRoute('/ask?q=hi')).toBe('/ask');
		expect(sanitizeRoute('/about#sources')).toBe('/about');
	});
	it('rejects an unknown or hostile path', () => {
		expect(sanitizeRoute('/secret')).toBeNull();
		expect(sanitizeRoute('javascript:alert(1)')).toBeNull();
		expect(sanitizeRoute('https://evil.test/timeline')).toBeNull();
	});
	it('returns null for empty / null', () => {
		expect(sanitizeRoute('')).toBeNull();
		expect(sanitizeRoute(null)).toBeNull();
	});
});

describe('routeLabel', () => {
	it('maps each route to a friendly name (no leading slash)', () => {
		expect(routeLabel('/')).toBe('Home');
		expect(routeLabel('/timeline')).toBe('Timeline');
		expect(routeLabel('/about')).toBe('About');
	});
	it('returns null for a null route', () => {
		expect(routeLabel(null)).toBeNull();
	});
});
