/**
 * The key the SkillBridge answer is kept under in the timeline state; no task uses it. It sits in a file of its own
 * so the timeline store, which every page loads, can name the key without pulling in the plan's reader and write rules.
 */
export const SKILLBRIDGE_PLAN_KEY = 'skillbridge-plan';
