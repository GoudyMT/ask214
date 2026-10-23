/**
 * Loads SkillBridge's Home row on demand, so Home downloads none of the finder's code until a returning user's page asks
 * for it. A function of its own so a test can see whether the code was asked for.
 */
export const loadFinderHomeRow = () => import('./FinderHomeRow.svelte');
