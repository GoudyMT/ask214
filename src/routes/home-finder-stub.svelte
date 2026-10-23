<script module lang="ts">
	// A stand-in for SkillBridge's Home row, for the Home page's tests: a test sets `stub.present`, and the stand-in
	// reports it to the page as the real row does. The real row has its own tests.
	export const stub = $state({ present: false, mounts: 0 });
</script>

<script lang="ts">
	import GlanceRow from '$lib/components/GlanceRow.svelte';

	let { onpresent }: { onpresent: (present: boolean) => void } = $props();

	stub.mounts++;
	$effect(() => {
		onpresent(stub.present);
		return () => onpresent(false);
	});
</script>

{#if stub.present}
	<GlanceRow row={{ name: 'SkillBridge', detail: 'Stand-in' }} to="/skillbridge" />
{/if}
