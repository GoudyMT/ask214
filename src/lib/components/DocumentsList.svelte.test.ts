import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import DocumentsList from './DocumentsList.svelte';
import type { DocumentRow, SaveProgress } from './DocumentsList.svelte';

// Real-shaped rows with DIFFERENT sizes, so every total can come from only one set of rows.
const ROWS: DocumentRow[] = [
	{
		sourceId: 'tap_vet_centers',
		title: 'TAP - Vet Centers (Resource Guide)',
		publisher: 'VA',
		pages: 2,
		bytes: 289_929,
		state: 'saved'
	},
	{
		sourceId: 'tap_va101',
		title: 'TAP - VA Benefits 101 (Resource Guide)',
		publisher: 'VA',
		pages: 4,
		bytes: 386_193,
		state: 'unsaved'
	},
	{
		sourceId: 'tap_dol_efct',
		title: 'TAP - DOL Employment Fundamentals of Career Transition',
		publisher: 'DOL',
		pages: 60,
		bytes: 13_054_075,
		state: 'updated'
	},
	{
		sourceId: 'tap_va_home_loan',
		title: 'TAP - VA Home Loan (Resource Guide)',
		publisher: 'VA',
		pages: 1,
		bytes: 327_357,
		state: 'saved'
	}
];
// Saved: 289,929 + 327,357 = 617,286 -> 0.6 MB. Remaining: 386,193 + 13,054,075 = 13,440,268 -> 13.4 MB.

const IDLE: SaveProgress = {
	running: false,
	done: 0,
	total: 0,
	bytesDone: 0,
	bytesTotal: 0,
	stoppedBy: null
};

function props(over: Record<string, unknown> = {}) {
	return {
		rows: ROWS,
		online: true,
		webSources: 25,
		progress: IDLE,
		onopen: vi.fn(),
		onsave: vi.fn(),
		onremove: vi.fn(),
		onsaveall: vi.fn(),
		onstop: vi.fn(),
		onremoveall: vi.fn(),
		...over
	};
}

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const button = (container: Element, label: string) =>
	[...container.querySelectorAll('button')].find((b) => text(b) === label);
const row = (container: Element, title: string) =>
	[...container.querySelectorAll('li')].find((li) => li.textContent?.includes(title));

describe('DocumentsList', () => {
	it('sums what is saved, and offers the rest with its count and size', () => {
		const { container } = render(DocumentsList, { props: props() });
		expect(text(container)).toContain('2 of 4 saved on this device - 0.6 MB');
		expect(button(container, 'Save 2 remaining (13.4 MB)')).toBeDefined();
		expect(text(container)).toContain(
			'Saved documents open without a connection and stay until you remove them.'
		);
	});

	it('groups the documents into saved and not saved, an updated one among the not saved', () => {
		const { container } = render(DocumentsList, { props: props() });
		// The dialogs' headings are in the DOM while closed; only the list's own headings are groups.
		const groups = [...container.querySelectorAll('h2')]
			.filter((h) => !h.closest('dialog'))
			.map(text);
		expect(groups).toEqual(['Saved (2)', 'Not saved (2)']);
		const [saved, unsaved] = [...container.querySelectorAll('ul')];
		expect(text(saved as Element)).toContain('Vet Centers');
		expect(text(saved as Element)).toContain('Home Loan');
		expect(text(unsaved as Element)).toContain('Benefits 101');
		expect(text(unsaved as Element)).toContain('Employment Fundamentals');
	});

	it("states each row's publisher, pages and size, and whether it is saved or updated", () => {
		const { container } = render(DocumentsList, { props: props() });
		expect(text(row(container, 'Vet Centers') as Element)).toContain(
			'Saved - VA - 2 pages - 0.3 MB'
		);
		expect(text(row(container, 'Home Loan') as Element)).toContain('Saved - VA - 1 page - 0.3 MB');
		expect(text(row(container, 'Benefits 101') as Element)).toContain('VA - 4 pages - 0.4 MB');
		expect(text(row(container, 'Benefits 101') as Element)).not.toContain('Saved');
		expect(text(row(container, 'Employment Fundamentals') as Element)).toContain(
			'Updated - the new version is not saved - DOL - 60 pages - 13.1 MB'
		);
	});

	it('offers Remove on a saved row, Save on an unsaved one and Save again on an updated one', () => {
		const onsave = vi.fn();
		const onremove = vi.fn();
		const { container } = render(DocumentsList, { props: props({ onsave, onremove }) });
		const saved = row(container, 'Vet Centers') as Element;
		const unsaved = row(container, 'Benefits 101') as Element;
		const updated = row(container, 'Employment Fundamentals') as Element;

		// Removing one needs no dialog: saving it again costs one tap.
		button(saved, 'Remove')?.click();
		expect(onremove).toHaveBeenCalledWith('tap_vet_centers');
		button(unsaved, 'Save')?.click();
		expect(onsave).toHaveBeenCalledWith('tap_va101');
		button(updated, 'Save again')?.click();
		expect(onsave).toHaveBeenLastCalledWith('tap_dol_efct');
		expect(container.querySelector('dialog[open]')).toBeNull();
	});

	// An update leaves the older copy of a document on the device until it is saved again or removed. It is part
	// of what the device holds, so it is counted, freed by Remove all, and can be removed on its own.
	describe('an older copy', () => {
		const OLDER = { count: 1, bytes: 22_000_000 };

		it('is counted with what is saved, and in what Remove all frees', () => {
			const { container } = render(DocumentsList, { props: props({ older: OLDER }) });
			expect(text(container.querySelector('.docs-sum__count') as Element)).toBe(
				'2 of 4 saved on this device - 0.6 MB, plus 1 older copy (22.0 MB)'
			);
			expect(text(container)).toContain(
				'Frees 22.6 MB. The search model, the answer library and your data stay.'
			);
		});

		it("is removed from its row, and focus goes to the row's title", () => {
			const onremove = vi.fn();
			const { container } = render(DocumentsList, { props: props({ older: OLDER, onremove }) });
			const updated = row(container, 'Employment Fundamentals') as Element;
			expect(button(updated, 'Save again')).toBeDefined();

			button(updated, 'Remove')?.click();
			expect(onremove).toHaveBeenCalledWith('tap_dol_efct');
			expect(document.activeElement).toBe(container.querySelector('#doc-tap_dol_efct'));
		});

		it('can be removed offline, when it cannot be saved again', () => {
			const { container } = render(DocumentsList, {
				props: props({ older: OLDER, online: false })
			});
			const updated = row(container, 'Employment Fundamentals') as Element;
			expect(text(updated)).toContain('Needs a connection');
			expect(button(updated, 'Remove')).toBeDefined();
		});

		it('keeps Remove all when it is all the device holds, and names it in the question', () => {
			const rows = ROWS.map((r) => ({ ...r, state: r.state === 'saved' ? 'unsaved' : r.state }));
			const { container } = render(DocumentsList, { props: props({ rows, older: OLDER }) });
			expect(button(container, 'Remove all saved documents')).toBeDefined();
			button(container, 'Remove all saved documents')?.click();

			const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
			expect(text(dialog)).toContain('This frees 22.0 MB.');
			expect(button(dialog, 'Remove 1 older copy')).toBeDefined();
		});

		// The device would not give its size: it is counted without one, and what Remove all frees is not stated,
		// since any figure would be wrong.
		it('is counted without a size when its size cannot be read, and what Remove all frees is left out', () => {
			const { container } = render(DocumentsList, {
				props: props({ older: { count: 1, bytes: null } })
			});
			expect(text(container.querySelector('.docs-sum__count') as Element)).toBe(
				'2 of 4 saved on this device - 0.6 MB, plus 1 older copy'
			);
			expect(text(container.querySelector('.docs-hint') as Element)).toBe(
				'The search model, the answer library and your data stay.'
			);
			button(container, 'Remove all saved documents')?.click();

			const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
			expect(text(dialog.querySelector('p') as Element)).toBe(
				'The search model, the answer library and your data stay. You can save any document again with a connection.'
			);
			expect(button(dialog, 'Remove 2 documents and 1 older copy')).toBeDefined();
		});

		it('is named beside the documents in the Remove all question, in the plural when more than one', () => {
			const { container } = render(DocumentsList, {
				props: props({ older: { count: 2, bytes: 30_000_000 } })
			});
			expect(text(container)).toContain('plus 2 older copies (30.0 MB)');
			button(container, 'Remove all saved documents')?.click();

			const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
			expect(text(dialog)).toContain('This frees 30.6 MB.');
			expect(button(dialog, 'Remove 2 documents and 2 older copies')).toBeDefined();
		});
	});

	it('opens a document from its title', () => {
		const onopen = vi.fn();
		const { container } = render(DocumentsList, { props: props({ onopen }) });
		button(container, 'TAP - VA Benefits 101 (Resource Guide)')?.click();
		expect(onopen).toHaveBeenCalledWith('tap_va101');
	});

	it('offline, says what cannot be saved and turns Save into "Needs a connection"', () => {
		const { container } = render(DocumentsList, {
			props: props({ online: false, libraryHeld: true })
		});
		expect(text(container)).toContain(
			'You are offline: documents not saved yet cannot be saved now, but their text still opens.'
		);
		expect(text(row(container, 'Benefits 101') as Element)).toContain('Needs a connection');
		expect(button(row(container, 'Benefits 101') as Element, 'Save')).toBeUndefined();
		expect(button(container, 'Save 2 remaining (13.4 MB)')?.disabled).toBe(true);
		// A saved document can still be removed offline.
		expect(button(row(container, 'Vet Centers') as Element, 'Remove')).toBeDefined();
	});

	// A document's text comes from the answer library. Without it on the device, nothing not saved opens offline,
	// so the line promises nothing.
	it('offline without the answer library, does not say the text still opens', () => {
		const { container } = render(DocumentsList, { props: props({ online: false }) });
		expect(
			container.querySelector('.docs-sum__note')?.textContent?.replace(/\s+/g, ' ').trim()
		).toBe(
			'Saved documents open without a connection and stay until you remove them. You are offline: documents not saved yet cannot be saved now.'
		);
	});

	// The device holds the page reader and the answer library, so the question names only the documents.
	it('asks before saving the rest, stating how many and how much', async () => {
		const onsaveall = vi.fn();
		const { container } = render(DocumentsList, {
			props: props({ onsaveall, libraryHeld: true })
		});
		button(container, 'Save 2 remaining (13.4 MB)')?.click();

		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		expect(text(dialog)).toContain('Save 2 more documents?');
		expect(text(dialog)).toContain(
			'They take 13.4 MB and stay on this device until you remove them. If your data is limited, use Wi-Fi.'
		);
		expect(onsaveall).not.toHaveBeenCalled();
		button(dialog, 'Save 2 documents')?.click();
		expect(onsaveall).toHaveBeenCalledTimes(1);
		expect(dialog.open).toBe(false);
	});

	// The first save also stores the page reader and the answer library. The question names whichever of them is
	// missing, with its size, and the total stays the documents' own, as the list states them.
	describe('the save-all question names what the first save also stores', () => {
		const question = (over: Record<string, unknown>) => {
			const { container } = render(DocumentsList, { props: props(over) });
			button(container, 'Save 2 remaining (13.4 MB)')?.click();
			return text(container.querySelector('dialog[open] p') as Element);
		};

		it('the page reader and the answer library, while both are missing', () => {
			expect(question({ libraryMissing: true, libraryHeld: false })).toBe(
				'They take 13.4 MB and stay on this device until you remove them. The first save also stores the page reader and the answer library (9.1 MB), once, so their text opens offline too. If your data is limited, use Wi-Fi.'
			);
		});

		it('the page reader alone, while only it is missing', () => {
			expect(question({ libraryMissing: true, libraryHeld: true })).toBe(
				'They take 13.4 MB and stay on this device until you remove them. The first save also stores the page reader (1.7 MB), once. If your data is limited, use Wi-Fi.'
			);
		});

		it('the answer library alone, while only it is missing', () => {
			expect(question({ libraryMissing: false, libraryHeld: false })).toBe(
				'They take 13.4 MB and stay on this device until you remove them. The first save also stores the answer library (7.3 MB), once, so their text opens offline too. If your data is limited, use Wi-Fi.'
			);
		});

		// Before the device has been read, whether the answer library is here is not known, and it is not named.
		it('not the answer library while the device has not been read', () => {
			expect(question({ libraryMissing: true, libraryHeld: null })).toBe(
				'They take 13.4 MB and stay on this device until you remove them. The first save also stores the page reader (1.7 MB), once. If your data is limited, use Wi-Fi.'
			);
			expect(question({ libraryMissing: false, libraryHeld: null })).toBe(
				'They take 13.4 MB and stay on this device until you remove them. If your data is limited, use Wi-Fi.'
			);
		});
	});

	it('saves nothing when the user cancels the save-all question', () => {
		const onsaveall = vi.fn();
		const { container } = render(DocumentsList, { props: props({ onsaveall }) });
		button(container, 'Save 2 remaining (13.4 MB)')?.click();
		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		button(dialog, 'Cancel')?.click();
		expect(dialog.open).toBe(false);
		expect(onsaveall).not.toHaveBeenCalled();
	});

	// The erase dialog's shape: Cancel is the focused default, the destructive action quiet.
	it('confirms removing everything saved, with Cancel focused, and says what stays', async () => {
		const onremoveall = vi.fn();
		const { container } = render(DocumentsList, { props: props({ onremoveall }) });
		expect(text(container)).toContain(
			'Frees 0.6 MB. The search model, the answer library and your data stay.'
		);
		button(container, 'Remove all saved documents')?.click();

		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		expect(text(dialog)).toContain('Remove all saved documents?');
		expect(text(dialog)).toContain(
			'This frees 0.6 MB. The search model, the answer library and your data stay. You can save any document again with a connection.'
		);
		expect(document.activeElement).toBe(button(dialog, 'Cancel'));
		expect(onremoveall).not.toHaveBeenCalled();
		button(dialog, 'Remove 2 documents')?.click();
		expect(onremoveall).toHaveBeenCalledTimes(1);
		expect(dialog.open).toBe(false);
	});

	it('speaks of a single document in the singular', () => {
		const rows = [ROWS[0], ROWS[1]] as DocumentRow[];
		const { container } = render(DocumentsList, { props: props({ rows }) });

		button(container, 'Save 1 remaining (0.4 MB)')?.click();
		const save = container.querySelector('dialog[open]') as HTMLDialogElement;
		expect(text(save)).toContain('Save 1 more document?');
		expect(button(save, 'Save 1 document')).toBeDefined();
		button(save, 'Cancel')?.click();

		button(container, 'Remove all saved documents')?.click();
		const remove = container.querySelector('dialog[open]') as HTMLDialogElement;
		expect(button(remove, 'Remove 1 document')).toBeDefined();
	});

	it('hides Remove all when nothing is saved, and Save all when everything is', () => {
		const none = ROWS.map((r) => ({ ...r, state: 'unsaved' as const }));
		const all = ROWS.map((r) => ({ ...r, state: 'saved' as const }));
		const empty = render(DocumentsList, { props: props({ rows: none }) }).container;
		expect(button(empty, 'Remove all saved documents')).toBeUndefined();
		expect(text(empty)).toContain('Save 4 remaining (14.1 MB)');
		const full = render(DocumentsList, { props: props({ rows: all }) }).container;
		expect(text(full)).not.toMatch(/Save \d+ remaining/);
		expect(button(full, 'Remove all saved documents')).toBeDefined();
	});

	it('shows progress while saving, with a way to stop, and no other save offered', () => {
		const onstop = vi.fn();
		const progress: SaveProgress = {
			running: true,
			done: 1,
			total: 2,
			bytesDone: 386_193,
			bytesTotal: 13_440_268,
			stoppedBy: null
		};
		const { container } = render(DocumentsList, { props: props({ progress, onstop }) });
		expect(text(container)).toContain('Saving 1 of 2 - 0.4 MB of 13.4 MB');
		expect(text(container)).toContain('(what is already saved stays)');
		expect(text(container)).not.toMatch(/Save \d+ remaining/);
		expect(
			button(row(container, 'Employment Fundamentals') as Element, 'Save again')
		).toBeUndefined();
		button(container, 'Stop')?.click();
		expect(onstop).toHaveBeenCalledTimes(1);
	});

	const STOPPED = {
		user: 'Stopped - 1 of 2 saved. What is saved stays.',
		offline: 'Stopped - 1 of 2 saved. The connection dropped; what is saved stays.',
		quota: 'Stopped - 1 of 2 saved. This device is out of storage; what is saved stays.',
		failed: 'Stopped - 1 of 2 saved. A document could not be downloaded; what is saved stays.'
	} as const;
	for (const [reason, copy] of Object.entries(STOPPED)) {
		it(`says how many were saved and why a run stopped (${reason})`, () => {
			const progress: SaveProgress = {
				running: false,
				done: 1,
				total: 2,
				bytesDone: 386_193,
				bytesTotal: 13_440_268,
				stoppedBy: reason as SaveProgress['stoppedBy']
			};
			const { container } = render(DocumentsList, { props: props({ progress }) });
			expect(text(container)).toContain(copy);
		});
	}

	const NOT_SAVED = {
		offline: 'Not saved - no connection.',
		quota: 'Not saved - this device is out of storage.',
		failed: 'Not saved - the download failed. Try again.'
	} as const;
	for (const [reason, copy] of Object.entries(NOT_SAVED)) {
		it(`says why one save failed and still offers it (${reason})`, () => {
			const { container } = render(DocumentsList, {
				props: props({ failed: { tap_va101: reason } })
			});
			const failedRow = row(container, 'Benefits 101') as Element;
			expect(text(failedRow)).toContain(copy);
			expect(button(failedRow, 'Save')).toBeDefined();
		});
	}

	// A disabled button drops focus (measured in both engines), so the Save is marked unavailable instead: it keeps
	// focus and looks as a disabled one does, and a press does nothing.
	it('marks a row whose save is in progress unavailable, so it cannot be started twice', () => {
		const onsave = vi.fn();
		const { container } = render(DocumentsList, {
			props: props({ busy: ['tap_va101'], onsave })
		});
		const saving = button(row(container, 'Benefits 101') as Element, 'Save') as HTMLButtonElement;
		expect(saving.getAttribute('aria-disabled')).toBe('true');
		expect(getComputedStyle(saving).opacity).toBe('0.45');
		saving.click();
		expect(onsave).not.toHaveBeenCalled();

		const other = button(row(container, 'Employment Fundamentals') as Element, 'Save again');
		expect(other?.getAttribute('aria-disabled')).toBe('false');
		expect(getComputedStyle(other as Element).opacity).toBe('1');
	});

	it("keeps focus on a row's Save while its save runs", async () => {
		const { container, rerender } = render(DocumentsList, { props: props() });
		const pressed = button(row(container, 'Benefits 101') as Element, 'Save') as HTMLElement;
		pressed.focus();
		pressed.click();

		await rerender({ busy: ['tap_va101'] });
		expect(document.activeElement).toBe(pressed);
		expect(pressed.getAttribute('aria-disabled')).toBe('true');
	});

	// Its own save already brings it, so Save all neither counts it nor downloads it a second time.
	it('leaves a row being saved out of Save all, still listing it as not saved', () => {
		const { container } = render(DocumentsList, { props: props({ busy: ['tap_va101'] }) });
		expect(button(container, 'Save 1 remaining (13.1 MB)')).toBeDefined();
		button(container, 'Save 1 remaining (13.1 MB)')?.click();

		const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
		expect(text(dialog)).toContain('Save 1 more document?');
		expect(text(dialog)).toContain('They take 13.1 MB and stay on this device');
		expect(button(dialog, 'Save 1 document')).toBeDefined();
		const groups = [...container.querySelectorAll('h2')].filter((h) => !h.closest('dialog'));
		expect(groups.map(text)).toEqual(['Saved (2)', 'Not saved (2)']);
	});

	it('offers no Save all while every document not saved is being saved on its own', () => {
		const { container } = render(DocumentsList, {
			props: props({ busy: ['tap_va101', 'tap_dol_efct'] })
		});
		expect(text(container)).toContain('2 of 4 saved on this device - 0.6 MB');
		expect(text(container)).not.toMatch(/Save \d+ remaining/);
	});

	// A screen reader may not speak a live region inserted with its words already in it, so each region is there,
	// empty, before its words change.
	it("announces a row's failed save in a status line that was there before it", async () => {
		const { container, rerender } = render(DocumentsList, { props: props() });
		const line = () => (row(container, 'Benefits 101') as Element).querySelector('[role="status"]');
		const before = line();
		expect(before).not.toBeNull();
		expect(text(before as Element)).toBe('');

		await rerender({ failed: { tap_va101: 'failed' } });
		expect(line()).toBe(before);
		expect(text(before as Element)).toBe('Not saved - the download failed. Try again.');
	});

	it("announces a run's progress and how it ended in a status line that was there before it", async () => {
		const { container, rerender } = render(DocumentsList, { props: props() });
		// Every live region outside the rows but the count.
		const regions = () =>
			[...container.querySelectorAll('[role="status"]')].filter(
				(el) => !el.closest('li') && !el.classList.contains('docs-sum__count')
			);
		const [line] = regions();
		expect(regions()).toHaveLength(1);
		expect(text(line as Element)).toBe('');

		const running: SaveProgress = {
			running: true,
			done: 1,
			total: 2,
			bytesDone: 386_193,
			bytesTotal: 13_440_268,
			stoppedBy: null
		};
		await rerender({ progress: running });
		expect(regions()).toEqual([line]);
		expect(text(line as Element)).toContain('Saving 1 of 2 - 0.4 MB of 13.4 MB');

		await rerender({ progress: { ...running, running: false, stoppedBy: 'user' } });
		expect(regions()).toEqual([line]);
		expect(text(line as Element)).toBe('Stopped - 1 of 2 saved. What is saved stays.');
	});

	// The line already on screen says what changed, so saying it aloud adds no words of its own.
	it('announces the saved count as it changes', () => {
		const { container } = render(DocumentsList, { props: props() });
		const count = container.querySelector('.docs-sum__count') as HTMLElement;
		expect(text(count)).toBe('2 of 4 saved on this device - 0.6 MB');
		expect(count.getAttribute('role')).toBe('status');
	});

	const as = (states: Record<string, DocumentRow['state']>) =>
		ROWS.map((r) => ({ ...r, state: states[r.sourceId] ?? r.state }));
	const groups = (container: Element) => [...container.querySelectorAll('ul')];
	const BENEFITS = 'TAP - VA Benefits 101 (Resource Guide)';
	const VET_CENTERS = 'TAP - Vet Centers (Resource Guide)';

	// A row's own Save or Remove moves it to the other group, where the list builds it anew: the pressed button
	// is gone, and focus would fall to the page with it. It follows the row to its title in its new place.
	describe('focus after a row moves', () => {
		it('follows a row saved from its own Save to its title among the saved', async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const pressed = button(row(container, 'Benefits 101') as Element, 'Save') as HTMLElement;
			pressed.focus();
			pressed.click();

			// The page marks it busy while it saves, then passes it back saved.
			await rerender({ busy: ['tap_va101'] });
			await rerender({ busy: [], rows: as({ tap_va101: 'saved' }) });
			const title = button(groups(container)[0] as Element, BENEFITS);
			expect(title).toBeDefined();
			expect(document.activeElement).toBe(title);
		});

		it('follows a removed row to its title among the not saved, and only once', async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const pressed = button(row(container, 'Vet Centers') as Element, 'Remove') as HTMLElement;
			pressed.focus();
			pressed.click();

			await rerender({ rows: as({ tap_vet_centers: 'unsaved' }) });
			const title = button(groups(container)[1] as Element, VET_CENTERS);
			expect(title).toBeDefined();
			expect(document.activeElement).toBe(title);

			// Focus moves on, and the lists change again for another row: this one is not followed twice.
			title?.blur();
			await rerender({ rows: as({ tap_vet_centers: 'unsaved', tap_va_home_loan: 'unsaved' }) });
			expect(document.activeElement).toBe(document.body);
		});

		it('leaves focus where the user moved it while the save ran', async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const pressed = button(row(container, 'Benefits 101') as Element, 'Save') as HTMLElement;
			pressed.focus();
			pressed.click();
			await rerender({ busy: ['tap_va101'] });
			const elsewhere = button(container, VET_CENTERS) as HTMLElement;
			elsewhere.focus();

			await rerender({ busy: [], rows: as({ tap_va101: 'saved' }) });
			expect(document.activeElement).toBe(elsewhere);
		});
	});

	// Any control holding focus can go: a row's title rebuilt as its row moves on its own - the reader's save, or
	// Save all's - or a control hidden or disabled as a run starts or ends. Focus goes to that row's title in its
	// new place, or to the count when the control had no row, rather than falling to the page.
	describe('focus when the control holding it goes', () => {
		const RUNNING: SaveProgress = {
			running: true,
			done: 1,
			total: 2,
			bytesDone: 386_193,
			bytesTotal: 13_440_268,
			stoppedBy: null
		};
		const count = (container: Element) => container.querySelector('.docs-sum__count');

		it('follows a row that moves on its own to its title in its new place', async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			(button(container, BENEFITS) as HTMLElement).focus();

			await rerender({ rows: as({ tap_va101: 'saved' }) });
			const title = button(groups(container)[0] as Element, BENEFITS);
			expect(title).toBeDefined();
			expect(document.activeElement).toBe(title);
		});

		// The reader holds focus while its row is rebuilt; closing it returns focus to a title that is gone, and
		// the browser leaves it on the page.
		it('follows a row rebuilt while focus was elsewhere, once focus falls to the page', async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const reader = document.createElement('button');
			document.body.append(reader);
			try {
				(button(container, BENEFITS) as HTMLElement).focus();
				reader.focus();
				await rerender({ rows: as({ tap_va101: 'saved' }) });
				expect(document.activeElement).toBe(reader);

				reader.blur();
				await vi.waitFor(() =>
					expect(document.activeElement).toBe(button(groups(container)[0] as Element, BENEFITS))
				);
			} finally {
				reader.remove();
			}
		});

		// Measured: WebKit sends no focusout when the focused control is removed, so the list cannot wait to be
		// told. Here the browser's report is held back the same way.
		it('follows a rebuilt row even when the browser does not report the lost focus', async () => {
			const silence = (event: Event) => event.stopPropagation();
			window.addEventListener('focusout', silence, { capture: true });
			try {
				const { container, rerender } = render(DocumentsList, { props: props() });
				(button(container, BENEFITS) as HTMLElement).focus();

				await rerender({ rows: as({ tap_va101: 'saved' }) });
				await vi.waitFor(() =>
					expect(document.activeElement).toBe(button(groups(container)[0] as Element, BENEFITS))
				);
			} finally {
				window.removeEventListener('focusout', silence, { capture: true });
			}
		});

		it("goes to the count when Save all's button goes as the run starts", async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const opener = button(container, 'Save 2 remaining (13.4 MB)') as HTMLElement;
			opener.focus();
			opener.click();
			const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
			button(dialog, 'Save 2 documents')?.click();
			expect(document.activeElement).toBe(opener);

			await rerender({ progress: RUNNING });
			expect(button(container, 'Save 2 remaining (13.4 MB)')).toBeUndefined();
			await vi.waitFor(() => expect(document.activeElement).toBe(count(container)));
		});

		it('goes to the count when Stop goes as the run ends', async () => {
			const { container, rerender } = render(DocumentsList, {
				props: props({ progress: RUNNING })
			});
			const stop = button(container, 'Stop') as HTMLElement;
			stop.focus();
			stop.click();

			await rerender({ progress: { ...RUNNING, running: false, stoppedBy: 'user' } });
			await vi.waitFor(() => expect(document.activeElement).toBe(count(container)));
		});

		it("goes to the count when Remove all's question removes the button that opened it", async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const opener = button(container, 'Remove all saved documents') as HTMLElement;
			opener.focus();
			opener.click();
			const dialog = container.querySelector('dialog[open]') as HTMLDialogElement;
			button(dialog, 'Remove 2 documents')?.click();
			expect(document.activeElement).toBe(opener);

			await rerender({ rows: as({ tap_vet_centers: 'unsaved', tap_va_home_loan: 'unsaved' }) });
			expect(button(container, 'Remove all saved documents')).toBeUndefined();
			await vi.waitFor(() => expect(document.activeElement).toBe(count(container)));
		});

		it("goes to the count when Save all's button can no longer be pressed", async () => {
			const { container, rerender } = render(DocumentsList, { props: props() });
			const saveRest = button(container, 'Save 2 remaining (13.4 MB)') as HTMLButtonElement;
			saveRest.focus();

			await rerender({ online: false });
			expect(saveRest.disabled).toBe(true);
			await vi.waitFor(() => expect(document.activeElement).toBe(count(container)));
		});

		// The Stopped line is shorter than the progress it replaces, above the view here, and the browser would
		// scroll to keep the view on the same content. That is turned off, so only a focus can scroll the view.
		it('moves focus without scrolling the view', async () => {
			const { container, rerender } = render(DocumentsList, {
				props: props({ progress: RUNNING })
			});
			const spacer = document.createElement('div');
			spacer.style.height = '5000px';
			document.body.append(spacer);
			document.documentElement.style.overflowAnchor = 'none';
			try {
				(button(container, 'Stop') as HTMLElement).focus();
				const line = count(container) as HTMLElement;
				window.scrollTo(0, line.getBoundingClientRect().bottom + window.scrollY + 200);
				const at = window.scrollY;
				expect(at).toBeGreaterThan(0);

				await rerender({ progress: { ...RUNNING, running: false, stoppedBy: 'user' } });
				await vi.waitFor(() => expect(document.activeElement).toBe(line));
				expect(window.scrollY).toBe(at);
			} finally {
				spacer.remove();
				document.documentElement.style.overflowAnchor = '';
				window.scrollTo(0, 0);
			}
		});
	});

	it('points to the web-page sources on About', () => {
		const { container } = render(DocumentsList, { props: props() });
		expect(text(container)).toContain(
			'25 more sources are web pages, read on their official sites.'
		);
		const about = [...container.querySelectorAll('a')].find(
			(a) => text(a) === 'See them all on About'
		);
		expect(about?.getAttribute('href')).toBe('/about');
	});
});
