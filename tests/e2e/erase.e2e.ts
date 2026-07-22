import { expect, test } from '@playwright/test';

// Coverage for "Erase all data on this device" - the headline privacy control, and the one action
// the user cannot undo or verify for themselves. Both halves matter: that it erases, and that it
// says so when it does not. A destructive action that fails quietly is worse than one that fails
// loudly, because the user walks away believing their data is gone.

async function seedProfile(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('textbox', { name: /ask a question/i })).toBeVisible();
}

test('erase removes the profile and lands on a clean first run', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The erase ends in window.location.reload(); wait for that to settle before navigating, or the
	// next goto aborts it. The separation date being gone is what proves the wipe reached disk.
	await expect(page.getByText('2027-04-15')).toBeHidden({ timeout: 15_000 });
	await expect(page.getByRole('button', { name: /^unlock$/i })).toBeHidden();

	// A fresh keystore means first-run: the Home setup CTA is offered again.
	await page.goto('/');
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeVisible();
});

test('a failed erase says so, and the data survives', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');
	await expect(page.getByText('2027-04-15')).toBeVisible();

	// Force a REAL failure rather than a mocked one: the store wipe runs under the `mtc-keystore`
	// lock held exclusively, so holding that lock makes the production path time out exactly as a
	// stuck peer tab would. Nothing here reaches into app internals.
	// Resolve only once the lock is actually GRANTED - requesting it is asynchronous, so returning
	// early would race the erase and the test would pass or fail on timing. It is held until this
	// test releases it explicitly, for the same reason.
	await page.evaluate(
		() =>
			new Promise<void>((granted) => {
				void navigator.locks
					.request(
						'mtc-keystore',
						{ mode: 'exclusive', signal: AbortSignal.timeout(60_000) },
						() => {
							granted();
							return new Promise<void>((release) => {
								window.addEventListener('test:release-lock', () => release(), { once: true });
							});
						}
					)
					.catch(() => {});
			})
	);

	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The lock acquisition is bounded at 10s, so the refusal surfaces rather than hanging forever.
	await expect(page.getByRole('alert')).toContainText(/could not erase/i, { timeout: 20_000 });

	// Hand the lock back before checking the data: reading it needs the same lock shared.
	await page.evaluate(() => window.dispatchEvent(new Event('test:release-lock')));

	// The claim the message makes must be true: the wipe is one transaction, so a failure leaves
	// every record intact. Unlock re-reads it from disk.
	await page.getByRole('button', { name: /^unlock$/i }).click();
	await expect(page.getByText('2027-04-15')).toBeVisible({ timeout: 15_000 });
});
