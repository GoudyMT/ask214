import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { describe, it, expect, vi } from 'vitest';
import ErrorPage from './+error.svelte';

// SvelteKit hands the error page the failure through the router's page state; a test sets it before it renders.
const failure = vi.hoisted(() => ({ status: 404, message: 'Not Found' }));
vi.mock('$app/state', () => ({
	page: {
		get status() {
			return failure.status;
		},
		get error() {
			return { message: failure.message };
		}
	}
}));

// The page a person lands on after a mistyped or outdated address, or when the app itself fails.
describe('the error page', () => {
	it('tells a person at a missing address that the page does not exist, and offers the way home', async () => {
		failure.status = 404;
		failure.message = 'Not Found';
		await render(ErrorPage);

		await expect
			.element(page.getByRole('heading', { level: 1, name: 'Page not found' }))
			.toBeVisible();
		await expect.element(page.getByText('This page does not exist.')).toBeVisible();
		const home = page.getByRole('link', { name: 'Go to Home' });
		await expect.element(home).toBeVisible();
		await expect.element(home).toHaveAttribute('href', '/');
		expect(document.title).toBe('Page not found - Ask 214');
	});

	// This file serves every failure, a server fault included: calling one "not found" would tell the person to
	// check an address that was never wrong.
	it('shows any other failure as its status and message, with the way home and no not-found words', async () => {
		failure.status = 500;
		failure.message = 'Internal Error';
		await render(ErrorPage);

		await expect
			.element(page.getByRole('heading', { level: 1, name: '500 - Internal Error' }))
			.toBeVisible();
		const home = page.getByRole('link', { name: 'Go to Home' });
		await expect.element(home).toHaveAttribute('href', '/');
		expect(document.title).toBe('Ask 214');
		expect(document.body.textContent).not.toContain('Page not found');
		expect(document.body.textContent).not.toContain('This page does not exist.');
	});
});
