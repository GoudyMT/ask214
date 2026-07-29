import { describe, it, expect } from 'vitest';
import { extractInput, serialize } from './http';

describe('extractInput', () => {
	it('reads method, origin, and the body query from a POST', async () => {
		const req = new Request('https://ask214.com/api/retrieve', {
			method: 'POST',
			headers: { origin: 'https://ask214.com', 'content-type': 'application/json' },
			body: JSON.stringify({ query: 'gi bill' })
		});
		expect(await extractInput(req)).toEqual({
			method: 'POST',
			origin: 'https://ask214.com',
			rawQuery: 'gi bill'
		});
	});

	it('yields a null origin when the header is absent', async () => {
		const req = new Request('https://ask214.com/api/retrieve', { method: 'GET' });
		const r = await extractInput(req);
		expect(r.method).toBe('GET');
		expect(r.origin).toBeNull();
		expect(r.rawQuery).toBeUndefined();
	});

	it('yields undefined query for a malformed body', async () => {
		const req = new Request('https://ask214.com/api/retrieve', {
			method: 'POST',
			headers: { origin: 'https://ask214.com' },
			body: 'not json{'
		});
		expect((await extractInput(req)).rawQuery).toBeUndefined();
	});

	it('yields undefined query when the body lacks a query field', async () => {
		const req = new Request('https://ask214.com/api/retrieve', {
			method: 'POST',
			headers: { origin: 'https://ask214.com', 'content-type': 'application/json' },
			body: JSON.stringify({ rate: 'E5' })
		});
		expect((await extractInput(req)).rawQuery).toBeUndefined();
	});
});

describe('serialize', () => {
	it('serializes a 405 reject with no-store', () => {
		const res = serialize({ kind: 'reject', httpStatus: 405 });
		expect(res.status).toBe(405);
		expect(res.headers.get('cache-control')).toBe('no-store');
	});

	it('serializes a 403 reject', () => {
		expect(serialize({ kind: 'reject', httpStatus: 403 }).status).toBe(403);
	});

	it('serializes a results body as JSON 200 with no-store', async () => {
		const res = serialize({
			kind: 'respond',
			body: { status: 'results', results: [], corpusVersion: '1.0' }
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({ status: 'results', results: [], corpusVersion: '1.0' });
	});

	it('serializes an error body as JSON 200 (the client maps status and degrades)', async () => {
		const res = serialize({ kind: 'respond', body: { status: 'error' } });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'error' });
	});
});
