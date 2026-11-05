<script lang="ts">
	// Test host: a parent that moves focus in the same update that removes the answer, as the Settings clock warning does.
	import SeparationPathRow from './SeparationPathRow.svelte';
	import type { SeparationPath } from '#lib/profile/separation-path.js';

	let { value }: { value: SeparationPath | undefined } = $props();
	let warning = $state<HTMLButtonElement | null>(null);

	$effect(() => {
		if (value === undefined) warning?.focus();
	});
</script>

<SeparationPathRow {value} onSave={async () => null} onRemove={async () => null} />
<button bind:this={warning}>Fix the clock</button>
