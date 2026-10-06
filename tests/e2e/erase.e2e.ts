import { expect, test } from '@playwright/test';

// Coverage for "Erase all data on this device" - the headline privacy control, and the one action
// the user cannot undo or verify for themselves. Both halves matter: that it erases, and that it
// says so when it does not. A destructive action that fails quietly is worse than one that fails
// loudly, because the user walks away believing their data is gone.

async function seedProfile(page: import('@playwright/test').Page): Promise<void> {
	await page.goto('/wizard');
	await page.getByLabel(/separation date/i).fill('2027-04-15');
	await page.getByRole('button', { name: /save and continue/i }).click();
	await expect(page.getByRole('heading', { level: 1, name: 'Timeline' })).toBeVisible();
}

// Flip one byte of the key record's check value, through a second connection, as damage on disk would.
async function damageKeyRecord(page: import('@playwright/test').Page): Promise<void> {
	await page.evaluate(
		() =>
			new Promise<void>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const tx = db.transaction('keystore', 'readwrite');
					const store = tx.objectStore('keystore');
					const get = store.get(0);
					get.onsuccess = () => {
						const row = get.result;
						const mac = new Uint8Array(row.recordHmac.slice(0));
						mac[0] = (mac[0] ?? 0) ^ 0xff;
						row.recordHmac = mac.buffer;
						store.put(row);
					};
					tx.oncomplete = () => {
						db.close();
						resolve();
					};
					tx.onerror = () => reject(new Error('E_TEST_WRITE'));
				};
			})
	);
}

// The key record's install id: a new one means the store was wiped and set up again.
async function installId(page: import('@playwright/test').Page): Promise<string> {
	return page.evaluate(
		() =>
			new Promise<string>((resolve, reject) => {
				const req = indexedDB.open('mtc');
				req.onerror = () => reject(new Error('E_TEST_OPEN'));
				req.onsuccess = () => {
					const db = req.result;
					const get = db.transaction('keystore', 'readonly').objectStore('keystore').get(0);
					get.onsuccess = () => {
						db.close();
						resolve(Array.from(get.result.installUuid as Uint8Array).join(','));
					};
					get.onerror = () => reject(new Error('E_TEST_READ'));
				};
			})
	);
}

test('erase removes the profile and lands on a clean first run', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');
	await expect(page.getByText('Apr 15, 2027')).toBeVisible();

	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The erase ends in window.location.reload(); wait for that to settle before navigating, or the
	// next goto aborts it. The separation date being gone is what proves the wipe reached disk.
	await expect(page.getByText('Apr 15, 2027')).toBeHidden({ timeout: 15_000 });
	await expect(page.getByRole('button', { name: /^unlock$/i })).toBeHidden();

	// A fresh keystore means first-run: the Home setup CTA is offered again.
	await page.goto('/');
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeVisible();
});

// A key record that fails its own check cannot be read by any reload. The banner points to the erase in Settings, which
// is the only way back, and erasing there starts the app again.
test('damaged saved data points to the erase in Settings, and erasing starts the app again', async ({
	page
}) => {
	await seedProfile(page);
	await damageKeyRecord(page);
	await page.reload();
	const banner = page.getByRole('alert');
	await expect(banner).toHaveText(
		"The information saved on this device can't be read. You can erase it in Settings and start again."
	);
	await expect(page.getByRole('button', { name: 'Reload' })).toHaveCount(0);
	// Settings is in the menu too, where Erase lives.
	await expect(page.getByRole('navigation').getByRole('link', { name: 'Settings' })).toBeVisible();

	await banner.getByRole('link', { name: 'Settings' }).click();
	await expect(page.getByRole('heading', { level: 2, name: 'Privacy and security' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^lock$/i })).toHaveCount(0);
	await page.getByRole('button', { name: /erase all data on this device/i }).click();
	await page.getByRole('button', { name: /^erase everything$/i }).click();

	// The erase ends in a reload onto a fresh key record: the banner is gone and Home offers the first-run set-up.
	await expect(page.getByText("can't be read")).toBeHidden({ timeout: 15_000 });
	await page.goto('/');
	await expect(page.getByRole('link', { name: /set up your timeline/i })).toBeVisible();
});

// Two tabs on the same damaged data. An erase in one starts it again, so the other must not keep offering an erase
// that would wipe what the first then sets up: a save in either tab reloads the other.
test('a tab on damaged data reloads when another tab saves new data', async ({ context }) => {
	const first = await context.newPage();
	await seedProfile(first);
	await damageKeyRecord(first);
	const second = await context.newPage();
	await second.goto('/settings');
	await expect(
		second.getByRole('heading', { level: 2, name: 'Privacy and security' })
	).toBeVisible();

	await first.goto('/settings');
	await first.getByRole('button', { name: /erase all data on this device/i }).click();
	await first.getByRole('button', { name: /^erase everything$/i }).click();
	await expect(first.getByText("can't be read")).toBeHidden({ timeout: 15_000 });
	// The erase ends in a reload: wait for it to land on a ready first run before reading the database.
	await expect(first.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible({
		timeout: 15_000
	});
	await seedProfile(first);

	// The second tab heard the save and read the data again: no erase offered, the new date shown.
	await expect(second.getByText("can't be read")).toBeHidden({ timeout: 15_000 });
	await expect(second.getByText('Apr 15, 2027')).toBeVisible();
});

// Before anything new is saved, the other tab still shows its old verdict. Its erase checks the data once more first,
// finds it reads, and reloads instead of wiping the first tab's fresh start.
test('a second erase on data another tab already erased checks first and wipes nothing', async ({
	context
}) => {
	const first = await context.newPage();
	await seedProfile(first);
	await damageKeyRecord(first);
	const second = await context.newPage();
	await second.goto('/settings');
	await expect(
		second.getByRole('heading', { level: 2, name: 'Privacy and security' })
	).toBeVisible();

	await first.goto('/settings');
	await first.getByRole('button', { name: /erase all data on this device/i }).click();
	await first.getByRole('button', { name: /^erase everything$/i }).click();
	await expect(first.getByText("can't be read")).toBeHidden({ timeout: 15_000 });
	// The erase ends in a reload: wait for it to land on a ready first run before reading the database.
	await expect(first.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible({
		timeout: 15_000
	});
	const fresh = await installId(first);

	await second.getByRole('button', { name: /erase all data on this device/i }).click();
	await second.getByRole('button', { name: /^erase everything$/i }).click();
	await expect(second.getByText("can't be read")).toBeHidden({ timeout: 15_000 });
	// The erase ends in a reload: wait for it to land on a ready first run before reading the database.
	await expect(second.getByRole('heading', { level: 2, name: 'Appearance' })).toBeVisible({
		timeout: 15_000
	});
	expect(await installId(second)).toBe(fresh);
});

test('a failed erase says so, and the data survives', async ({ page }) => {
	await seedProfile(page);
	await page.goto('/settings');
	await expect(page.getByText('Apr 15, 2027')).toBeVisible();

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
	await expect(page.getByText('Apr 15, 2027')).toBeVisible({ timeout: 15_000 });
});
