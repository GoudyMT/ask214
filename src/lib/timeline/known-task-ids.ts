/**
 * Every task id the app has ever shipped, as literals (not derived from
 * `TASK_DEFS`). A backup is checked against this list, so it only ever grows:
 * a new task id is added here in the commit that adds the task, and an id is
 * never removed - that way a backup made before a task was retired still
 * restores. The SkillBridge plan key is not a task and is not in this list.
 */
export const KNOWN_TASK_IDS: readonly string[] = Object.freeze([
	'va-gov-account',
	'login-gov-account',
	'update-sgli',
	'verify-service-record',
	'will-poa',
	'financial-counselor',
	'master-resume',
	'gi-bill-research',
	'document-medical',
	'preseparation-counseling',
	'tap-course',
	'tap-track',
	'skillbridge-find',
	'skillbridge-request',
	'job-search',
	'health-insurance-research',
	'life-insurance-research',
	'va-career-guidance',
	'jst-order',
	'reserve-affiliation',
	'school-apply',
	'sha-schedule',
	'sha-complete',
	'va-bdd-claim',
	'tap-capstone',
	'va-benefits-advisor',
	'reference-letters',
	'financial-docs',
	'hhg-counseling',
	'separation-package',
	'dd214-review',
	'tricare-elect',
	'dd214-copies',
	'tsp-decision',
	'vgli-convert',
	'final-pay-check',
	'va-claim-fallback'
]);
