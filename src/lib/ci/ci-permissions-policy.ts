/**
 * CI job-permission policy.
 *
 * Closes the "the highest code-exec job has no permissions block" gap: without an explicit
 * `permissions:` block a job's GITHUB_TOKEN inherits the repo/org default, which may grant write
 * across the board, and a future edit could add a write scope unnoticed. This pure checker lets a
 * vitest test assert every job has least-privilege (write-free) permissions -- from its own block
 * or the workflow top-level block.
 */

/** A GitHub Actions workflow, narrowed to the permissions surface this policy inspects. */
export interface WorkflowConfig {
	permissions?: unknown;
	jobs?: Record<string, { permissions?: unknown }>;
}

/**
 * Return a message for each job that is not least-privilege: one with no `permissions` block, one
 * granting the `write-all` shorthand, or one granting any per-scope `write` level.
 *
 * A read-only block (`contents: read`, or even `read-all`) is fine -- the invariant is "no write
 * capability", which is the token power an attacker who compromises the job could abuse.
 *
 * Args:
 *   workflow: the parsed workflow YAML (null for an empty document).
 *
 * Returns:
 *   Violation messages; empty when every job is least-privilege.
 */
export function findPermissionViolations(workflow: WorkflowConfig | null | undefined): string[] {
	const violations: string[] = [];
	// `parse('')` on an empty or comment-only workflow yields null; treat it as "no jobs".
	const jobs = workflow?.jobs ?? {};
	for (const [name, job] of Object.entries(jobs)) {
		// A job's effective permissions are its own block, else the workflow top-level block.
		const perms = job.permissions ?? workflow?.permissions;
		if (perms === undefined) {
			violations.push(`job "${name}" has no permissions block (token inherits the repo default)`);
			continue;
		}
		if (perms === 'write-all') {
			violations.push(`job "${name}" grants write-all`);
			continue;
		}
		if (typeof perms === 'object' && perms !== null) {
			for (const [scope, level] of Object.entries(perms as Record<string, unknown>)) {
				if (level === 'write') {
					violations.push(`job "${name}" grants ${scope}: write`);
				}
			}
		}
	}
	return violations;
}
