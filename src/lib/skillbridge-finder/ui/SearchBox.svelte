<script lang="ts">
	type Offer = {
		/** What the one-time download of every region would cost, in bytes, from the index. */
		bytes: number;
		/** The download is under way. */
		busy: boolean;
		onaccept: () => void;
		ondecline: () => void;
	};
	type Props = {
		value: string;
		/** The "search every region" question, shown under the field while it is open; null when there is none. */
		offer?: Offer | null;
	};
	let { value = $bindable(), offer = null }: Props = $props();

	const BYTES_PER_MB = 1_000_000;
	// One decimal, and never "0": a small download still says it is one.
	const megabytes = (bytes: number) => Math.max(0.1, Math.round(bytes / (BYTES_PER_MB / 10)) / 10);
</script>

<div class="search">
	<label for="finder-search">Search programs</label>
	<!-- No form around it: Enter has nothing to submit, and what is typed never reaches the address. -->
	<input
		id="finder-search"
		bind:value
		type="text"
		placeholder="Company, role, place or job code"
		autocomplete="off"
		autocapitalize="off"
		spellcheck="false"
		enterkeyhint="search"
	/>
	{#if offer}
		<div class="search__offer" role="group" aria-labelledby="finder-offer-title">
			<p>
				<strong id="finder-offer-title">Search every region?</strong>
				It downloads about {megabytes(offer.bytes)} MB of listings once. Until then only programs near
				you are searched.
			</p>
			<div class="search__offer-actions">
				<button
					type="button"
					class="search__primary"
					aria-busy={offer.busy}
					onclick={() => !offer.busy && offer.onaccept()}
				>
					{offer.busy ? 'Downloading...' : 'Search every region'}
				</button>
				<button type="button" class="search__link" onclick={offer.ondecline}>Near me only</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.search label {
		display: block;
		margin-bottom: var(--space-xs);
		font-weight: 600;
		font-size: var(--font-size-s);
	}

	.search input {
		width: 100%;
		min-height: 44px;
		padding: 0 var(--space-m);
		background: var(--color-bg);
		color: var(--color-fg);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-m);
		font: inherit;
	}

	.search input::placeholder {
		color: var(--color-fg-muted);
	}

	/* The app's offer cards: surface, a 3 px accent edge. */
	.search__offer {
		margin-top: var(--space-s);
		padding: var(--space-s) var(--space-m);
		background: var(--color-surface);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		border-radius: var(--radius-m);
	}

	.search__offer p {
		margin: 0;
	}

	.search__offer-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-m);
		margin-top: var(--space-s);
	}

	.search__primary {
		min-height: 44px;
		padding: 0 var(--space-m);
		background: var(--color-accent);
		color: var(--color-bg);
		border: none;
		border-radius: var(--radius-m);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
	}

	.search__link {
		min-height: 44px;
		padding: 0 var(--space-xs);
		background: none;
		border: none;
		color: var(--color-accent);
		font: inherit;
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
</style>
