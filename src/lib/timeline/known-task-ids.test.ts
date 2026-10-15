import { describe, it, expect } from 'vitest';
import { KNOWN_TASK_IDS } from './known-task-ids';
import { TASK_DEFS } from './task-defs';

// A frozen copy of every task id shipped so far. It is never edited to remove
// an id: a new id is appended here and in KNOWN_TASK_IDS together.
const SHIPPED_TASK_IDS: readonly string[] = [
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
];

describe('KNOWN_TASK_IDS', () => {
	it('every TASK_DEFS id is in KNOWN_TASK_IDS', () => {
		const known = new Set(KNOWN_TASK_IDS);
		const missing = TASK_DEFS.map((t) => t.id).filter((id) => !known.has(id));
		expect(missing).toEqual([]);
	});

	it('KNOWN_TASK_IDS keeps every id it has ever held', () => {
		expect(SHIPPED_TASK_IDS).toHaveLength(37);
		expect(KNOWN_TASK_IDS.slice(0, SHIPPED_TASK_IDS.length)).toEqual(SHIPPED_TASK_IDS);
	});

	it('KNOWN_TASK_IDS is frozen and has no duplicates', () => {
		expect(Object.isFrozen(KNOWN_TASK_IDS)).toBe(true);
		expect(new Set(KNOWN_TASK_IDS).size).toBe(KNOWN_TASK_IDS.length);
	});
});
