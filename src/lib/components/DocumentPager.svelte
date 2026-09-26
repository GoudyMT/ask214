<script lang="ts">
	// The reader's page bar: the page in view, as a number the reader can change to jump to a page. The scroll
	// does what Previous and Next would, so there are none; it only reports the page asked for, and the page
	// view scrolls there.
	let {
		page,
		pageCount,
		onpage
	}: {
		// The page in view, 1-based.
		page: number;
		pageCount: number;
		onpage: (page: number) => void;
	} = $props();

	// Plain, not state: the effect below runs after mount, when the binding is already set, and follows `page`.
	let inputEl: HTMLInputElement | undefined;

	// The number follows the page in view, except while the reader is typing in it: a scroll under a half-typed
	// number must not overwrite it.
	$effect(() => {
		const shown = String(page);
		if (inputEl && document.activeElement !== inputEl) inputEl.value = shown;
	});

	// A typed page moves the view only when it is a whole page inside the document. Anything else puts the
	// field back to the page in view, so it never shows a number the view is not on.
	function commit(input: HTMLInputElement): void {
		const typed = Number(input.value);
		// A blank field reads as 0, so the lower bound covers it too.
		if (Number.isInteger(typed) && typed >= 1 && typed <= pageCount) {
			onpage(typed);
		} else {
			input.value = String(page);
		}
	}
</script>

<nav class="pager" aria-label="Pages">
	<span>
		Page
		<input
			bind:this={inputEl}
			type="number"
			inputmode="numeric"
			min="1"
			max={pageCount}
			aria-label="Page number"
			onchange={(event) => commit(event.currentTarget)}
			onkeydown={(event) => {
				if (event.key === 'Enter') commit(event.currentTarget);
			}}
			onblur={(event) => (event.currentTarget.value = String(page))}
		/>
		of {pageCount}
	</span>
</nav>

<style>
	/* Pinned between the reader's scrolling body and its foot, so it never scrolls away. */
	.pager {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-m);
		padding: var(--space-s) var(--space-m);
		border-top: 1px solid var(--color-border);
		background: var(--color-surface);
		font-size: var(--font-size-s);
	}
	.pager input {
		width: 3.2em;
		padding: 4px;
		text-align: center;
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-s);
		font: inherit;
		font-size: var(--font-size-s);
	}
</style>
