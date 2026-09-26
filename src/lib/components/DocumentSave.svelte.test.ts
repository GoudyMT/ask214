import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import DocumentSave from './DocumentSave.svelte';
import { saveDocument, type SaveResult } from '$lib/sources/document-cache';

// Shaped like the generated map: a source id, a hash of the content, the extension. An update ships the same
// source under a new hash, so the older copy shares the source id and nothing else.
const PATH = '/docs/tap_vet_centers.1dcfd966.pdf';
const OLDER = '/docs/tap_vet_centers.0badc0de.pdf';
const OTHER = '/docs/tap_va101.5e2c9a1b.pdf';

function props(over: Record<string, unknown> = {}) {
	return {
		path: PATH,
		bytes: 289_929,
		list: vi.fn(async () => [] as string[]),
		save: vi.fn(async (): Promise<SaveResult> => 'saved'),
		isOnline: () => true,
		libraryHeld: async () => true,
		...over
	};
}

const text = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const saveButton = (el: Element) => el.querySelector('button');

describe('DocumentSave', () => {
	it('offers to save the document for offline, stating its size', async () => {
		const { container } = render(DocumentSave, { props: props() });

		await vi.waitFor(() => expect(text(container)).toBe('Save for offline (0.3 MB)'));
		expect(saveButton(container)?.getAttribute('aria-disabled')).toBe('false');
	});

	it('says the document is saved when this device holds it, and offers nothing', async () => {
		const { container } = render(DocumentSave, {
			props: props({ list: async () => [PATH] })
		});

		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
		expect(saveButton(container)).toBeNull();
	});

	it('says it is saved offline too, since what is saved opens without a connection', async () => {
		const { container } = render(DocumentSave, {
			props: props({ list: async () => [PATH], isOnline: () => false })
		});

		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
	});

	// Only an older version is held: the current one is not saved, so it is offered.
	it('offers to save when only an older copy of the document is held', async () => {
		const { container } = render(DocumentSave, {
			props: props({ list: async () => [OLDER] })
		});

		await vi.waitFor(() => expect(text(container)).toBe('Save for offline (0.3 MB)'));
	});

	it('shows nothing offline when the document is not saved', async () => {
		const list = vi.fn(async () => [] as string[]);
		const { container } = render(DocumentSave, {
			props: props({ list, isOnline: () => false })
		});

		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(text(container)).toBe('');
	});

	it('says it is saving, and cannot be pressed again, until the save ends', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi.fn(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const { container } = render(DocumentSave, { props: props({ save }) });

		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
		expect(saveButton(container)?.getAttribute('aria-disabled')).toBe('true');
		saveButton(container)?.click();
		expect(save).toHaveBeenCalledTimes(1);

		finish('saved');
		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
	});

	// A disabled button drops the focus it holds, in Chromium and in WebKit. The Save keeps it while it saves, so
	// a keyboard or screen reader user stays on it and hears it change.
	it('keeps focus on itself while it saves', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi.fn(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const { container } = render(DocumentSave, { props: props({ save }) });
		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.focus();
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
		expect(document.activeElement).toBe(saveButton(container));

		finish('saved');
		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
	});

	// The button pressed is gone once the save ends, and focus would fall to the page with it. It lands on the
	// line saying the document is saved, so a keyboard user keeps their place and a screen reader reads it.
	it('moves focus to the saved line when the save the user started succeeds', async () => {
		const { container } = render(DocumentSave, { props: props() });

		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.focus();
		saveButton(container)?.click();
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(container.querySelector('.save__done'))
		);
		expect(document.activeElement?.getAttribute('tabindex')).toBe('-1');
	});

	// On a short screen the reader's Save sits above the document in the scroll. Focus moved to the saved line
	// leaves the view where the reader scrolled while the save ran. The box keeps no place of its own, as in
	// WebKit: the saved line is shorter than the button, and Chromium would move the scroll to make up for it.
	it('moves focus to the saved line without scrolling the view', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi.fn(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const box = document.createElement('div');
		box.style.cssText = 'height: 100px; overflow-y: auto; overflow-anchor: none;';
		const target = document.createElement('div');
		const below = document.createElement('div');
		below.style.height = '2000px';
		box.append(target, below);
		document.body.appendChild(box);
		try {
			const { container } = render(DocumentSave, { props: props({ save }), target });
			await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
			saveButton(container)?.focus();
			saveButton(container)?.click();
			await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
			box.scrollTop = 1000;

			finish('saved');
			await vi.waitFor(() =>
				expect(document.activeElement).toBe(container.querySelector('.save__done'))
			);
			expect(box.scrollTop).toBe(1000);
		} finally {
			box.remove();
		}
	});

	it('moves no focus when the document is already saved as it opens', async () => {
		const before = document.activeElement;
		const { container } = render(DocumentSave, { props: props({ list: async () => [PATH] }) });

		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(document.activeElement).toBe(before);
	});

	// A save can take a while. A user who has moved on in the meantime is not pulled back to it.
	it('leaves focus where the user moved it while the save ran', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi.fn(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const elsewhere = document.createElement('button');
		document.body.appendChild(elsewhere);
		try {
			const { container } = render(DocumentSave, { props: props({ save }) });
			await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
			saveButton(container)?.focus();
			saveButton(container)?.click();
			await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
			elsewhere.focus();

			finish('saved');
			await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});

	// A save clears the older copies of the same document with it, and nothing of any other document.
	it('saves the current copy and clears only its older copies', async () => {
		const save = vi.fn(async (): Promise<SaveResult> => 'saved');
		const { container } = render(DocumentSave, {
			props: props({ list: async () => [OLDER, OTHER], save })
		});

		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.click();
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		expect(save).toHaveBeenCalledWith(PATH, [OLDER]);
	});

	// The Documents area's words for the same failures, with the Save still offered to try again.
	it.each([
		['offline', 'Not saved - no connection.'],
		['quota', 'Not saved - this device is out of storage.'],
		['failed', 'Not saved - the download failed. Try again.']
	] as const)('says why a save failed (%s) and offers it again', async (result, line) => {
		const save = vi.fn(async (): Promise<SaveResult> => result);
		const { container } = render(DocumentSave, { props: props({ save }) });

		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toContain(line));
		// A failure, said as an alert as it appears: a polite line put in with its words already in it is not always
		// spoken.
		expect(container.querySelector('.save__failed')?.getAttribute('role')).toBe('alert');
		expect(text(saveButton(container) as Element)).toBe('Save for offline (0.3 MB)');
		expect(saveButton(container)?.getAttribute('aria-disabled')).toBe('false');
	});

	it('drops the failure as soon as the user tries again', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi
			.fn<(path: string, stale: readonly string[]) => Promise<SaveResult>>()
			.mockResolvedValueOnce('offline')
			.mockImplementationOnce(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const { container } = render(DocumentSave, { props: props({ save }) });

		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toContain('Not saved - no connection.'));
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toBe('Saving...'));

		finish('saved');
		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
	});

	// A Save is built again while its document saves: the reader's foot moves when the screen crosses the short
	// line. It shows that save, not a second download, and then how the save ended.
	it('shows a save of its document already running, offers no second one, then how it ended', async () => {
		let finish!: (result: SaveResult) => void;
		const pending = new Promise<SaveResult>((resolve) => (finish = resolve));
		const save = vi.fn(async (): Promise<SaveResult> => 'saved');
		const { container } = render(DocumentSave, {
			props: props({ save, running: (path: string) => (path === PATH ? pending : undefined) })
		});

		await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(text(container)).toBe('Saving...');
		expect(saveButton(container)?.getAttribute('aria-disabled')).toBe('true');
		saveButton(container)?.click();
		expect(save).not.toHaveBeenCalled();

		finish('saved');
		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));
	});

	it('says why a save already running failed, and offers it again', async () => {
		const { container } = render(DocumentSave, {
			props: props({ running: async (): Promise<SaveResult> => 'offline' })
		});

		await vi.waitFor(() => expect(text(container)).toContain('Not saved - no connection.'));
		expect(saveButton(container)?.getAttribute('aria-disabled')).toBe('false');
	});

	// By default it asks the app's own saves, so a save started by another Save of the same document is found.
	it("finds a save another Save of the document started, through the app's own saves", async () => {
		let land = () => {};
		const gate = new Promise<void>((resolve) => (land = resolve));
		const cache = {
			match: async () => undefined,
			put: () => gate,
			delete: async () => true
		};
		const cachesApi = { open: async () => cache } as unknown as CacheStorage;
		const save = (path: string, stale: readonly string[]) =>
			saveDocument(path, stale, {
				fetchFn: async () => new Response('pdf'),
				cachesApi,
				isOnline: () => true,
				library: []
			});
		const first = render(DocumentSave, { props: props({ save }) });
		await vi.waitFor(() => expect(saveButton(first.container)).not.toBeNull());
		saveButton(first.container)?.click();
		await vi.waitFor(() => expect(text(first.container)).toBe('Saving...'));

		const second = render(DocumentSave, { props: props() });
		await vi.waitFor(() => expect(text(second.container)).toBe('Saving...'));
		land();
		await vi.waitFor(() => expect(text(second.container)).toBe('Saved on this device'));
	});

	// The reader gives focus back to a control it built again, and this one shows only once it has read the device.
	it('says when it shows what it read, and not before', async () => {
		let read!: (held: string[]) => void;
		let shownAtCall: boolean | null = null;
		const onshow = vi.fn(() => (shownAtCall = saveButton(container) !== null));
		const { container } = render(DocumentSave, {
			props: props({ list: () => new Promise<string[]>((resolve) => (read = resolve)), onshow })
		});

		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onshow).not.toHaveBeenCalled();
		read([]);
		await vi.waitFor(() => expect(onshow).toHaveBeenCalledTimes(1));
		expect(shownAtCall).toBe(true);
	});

	// A save that ends after the Save moved on to another document leaves that document as it is.
	it('leaves another document alone when a save ends after it moved on', async () => {
		let finish!: (result: SaveResult) => void;
		const save = vi.fn(() => new Promise<SaveResult>((resolve) => (finish = resolve)));
		const { container, rerender } = render(DocumentSave, { props: props({ save }) });
		await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
		saveButton(container)?.click();
		await vi.waitFor(() => expect(text(container)).toBe('Saving...'));

		await rerender({ path: OTHER, bytes: 1_234_567 });
		await vi.waitFor(() => expect(text(container)).toBe('Save for offline (1.2 MB)'));
		finish('saved');
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(text(container)).toBe('Save for offline (1.2 MB)');
	});

	// The reader closed while this Save read the device. Nothing it would have shown is called for.
	it('does nothing once it is gone', async () => {
		let read!: (held: string[]) => void;
		const onshow = vi.fn();
		const { unmount } = render(DocumentSave, {
			props: props({ list: () => new Promise<string[]>((resolve) => (read = resolve)), onshow })
		});

		unmount();
		read([]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(onshow).not.toHaveBeenCalled();
	});

	// Given another document and then the first again while its first read is still out, that read is dropped:
	// it belongs to a showing the Save has moved past, though the document is the same.
	it('drops a read that ends after it moved to another document and back', async () => {
		const reads: ((held: string[]) => void)[] = [];
		const onshow = vi.fn();
		const list = () => new Promise<string[]>((resolve) => reads.push(resolve));
		const { container, rerender } = render(DocumentSave, { props: props({ list, onshow }) });
		await vi.waitFor(() => expect(reads).toHaveLength(1));

		await rerender({ path: OTHER, bytes: 1_234_567 });
		await rerender({ path: PATH, bytes: 289_929 });
		await vi.waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(3));
		reads[0]?.([PATH]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(text(container)).toBe('');
		expect(onshow).not.toHaveBeenCalled();

		for (const read of reads.slice(1)) read([]);
		await vi.waitFor(() => expect(text(container)).toBe('Save for offline (0.3 MB)'));
	});

	// A save also stores the answer library when it is missing, so a saved document's text opens offline. Its
	// size is said under the Save while it is missing, and nothing is said before the device answers.
	describe('the line saying what the first save also stores', () => {
		const LINE = 'The first save also stores the answer library (7.3 MB), once.';

		it('says it under the Save while the answer library is missing', async () => {
			const { container } = render(DocumentSave, {
				props: props({ libraryHeld: async () => false })
			});
			await vi.waitFor(() => expect(text(container)).toContain(LINE));
			expect(text(saveButton(container) as Element)).toBe('Save for offline (0.3 MB)');
		});

		it('says nothing of it when the answer library is held', async () => {
			const libraryHeld = vi.fn(async () => true);
			const { container } = render(DocumentSave, { props: props({ libraryHeld }) });
			await vi.waitFor(() => expect(libraryHeld).toHaveBeenCalled());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(text(container)).toBe('Save for offline (0.3 MB)');
		});

		it('says nothing of it before the device has answered', async () => {
			const { container } = render(DocumentSave, {
				props: props({ libraryHeld: () => new Promise<boolean>(() => {}) })
			});
			await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(text(container)).toBe('Save for offline (0.3 MB)');
		});

		it('says nothing of it while the save runs', async () => {
			const save = vi.fn(() => new Promise<SaveResult>(() => {}));
			const { container } = render(DocumentSave, {
				props: props({ save, libraryHeld: async () => false })
			});
			await vi.waitFor(() => expect(text(container)).toContain(LINE));
			saveButton(container)?.click();
			await vi.waitFor(() => expect(text(container)).toBe('Saving...'));
		});

		// Asked again while the first answer is still out, the newer answer stands: the older one, arriving last,
		// speaks of a device that has changed since.
		it('drops an answer from the device that arrives after a newer one', async () => {
			const answers: ((held: boolean) => void)[] = [];
			const { container, rerender } = render(DocumentSave, {
				props: props({
					libraryHeld: () => new Promise<boolean>((resolve) => answers.push(resolve)),
					recheck: 'page'
				})
			});
			await vi.waitFor(() => expect(saveButton(container)).not.toBeNull());
			await rerender({ recheck: 'text' });
			await vi.waitFor(() => expect(answers.length).toBeGreaterThanOrEqual(2));

			answers[answers.length - 1]?.(true);
			await new Promise((resolve) => setTimeout(resolve, 20));
			answers[0]?.(false);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(text(container)).toBe('Save for offline (0.3 MB)');
		});

		// Opening the text online can store the answer library, so the reader asks again when the view changes.
		it('reads the device again when told the answer library may have changed', async () => {
			let held = false;
			const { container, rerender } = render(DocumentSave, {
				props: props({ libraryHeld: async () => held, recheck: 'page' })
			});
			await vi.waitFor(() => expect(text(container)).toContain(LINE));

			held = true;
			await rerender({ recheck: 'text' });
			await vi.waitFor(() => expect(text(container)).toBe('Save for offline (0.3 MB)'));
		});
	});

	// The reader keeps one foot across documents, so a new document is read afresh.
	it('reads what is held again when it is given another document', async () => {
		const { container, rerender } = render(DocumentSave, {
			props: props({ list: async () => [PATH] })
		});
		await vi.waitFor(() => expect(text(container)).toBe('Saved on this device'));

		await rerender({ path: OTHER, bytes: 1_234_567 });
		await vi.waitFor(() => expect(text(container)).toBe('Save for offline (1.2 MB)'));
	});
});
