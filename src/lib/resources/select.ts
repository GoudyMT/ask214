import type { DisplayCategory, Resource } from './types';
import { RESOURCES, TASK_RESOURCES } from './resources';

// Human-readable heading for each browse category, shown on the Resources page.
export const DISPLAY_CATEGORY_LABEL: Record<DisplayCategory, string> = {
	'benefits-va': 'Benefits & VA',
	'claims-vso': 'Claims filing (VSO)',
	employment: 'Employment',
	education: 'Education',
	finance: 'Finance',
	'skillbridge-transition': 'SkillBridge & Transition',
	'mentorship-networking': 'Mentorship & Networking',
	'health-wellbeing': 'Health & Wellbeing'
};

// Contextual surfacing: the curated resources for a timeline task, in the mapped order. A task with no
// mapping (or an unknown id) surfaces nothing. Map + resources are injectable for testing.
export function resourcesForTask(
	taskId: string,
	map: Record<string, readonly string[]> = TASK_RESOURCES,
	resources: readonly Resource[] = RESOURCES
): Resource[] {
	const byId = new Map(resources.map((r) => [r.id, r]));
	return (map[taskId] ?? []).flatMap((id) => {
		const r = byId.get(id);
		return r ? [r] : [];
	});
}

// Page grouping: bucket resources by their browse category, preserving input order within each bucket.
// Only categories that have at least one resource appear.
export function groupByDisplayCategory(
	resources: readonly Resource[]
): Map<DisplayCategory, Resource[]> {
	const groups = new Map<DisplayCategory, Resource[]>();
	for (const r of resources) {
		const bucket = groups.get(r.displayCategory);
		if (bucket) bucket.push(r);
		else groups.set(r.displayCategory, [r]);
	}
	return groups;
}
