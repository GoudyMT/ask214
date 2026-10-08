import { formatTimelineDate } from './format-date';
import type { PlanAnswer } from './skillbridge-plan';

/**
 * The SkillBridge lines the question and its Settings row show. They live here, not in the components, so the test
 * that holds every public line to 38 CFR 14.629 reads them all: none may say what the user qualifies for. The app's
 * shared wording (the failed-save line, "opens in a new tab", Save, Cancel) stays in the components, as in every other
 * component that uses it. The close button's name is here, not shared: the Timeline's calendar card has a "Dismiss" of
 * its own, and two buttons with one name on a page cannot be told apart by a screen reader.
 */
export const QUESTION_FIRST = {
	heading: 'Planning to do SkillBridge?',
	line: 'SkillBridge is the DoD program for civilian job training and internships in your last months of service. Say yes and its steps join your timeline.'
};
export const QUESTION_AGAIN = {
	heading: 'Still thinking about SkillBridge?',
	line: 'The search for a program works best from about 14 months before separation, and the request opens at 12 months. Say yes and its steps join your timeline.'
};
export const ANSWER_LABEL: Record<PlanAnswer, string> = {
	yes: 'Yes',
	'not-sure': 'Not sure',
	no: 'No'
};
export const SETTINGS_HINT = 'You can change this in Settings.';
export const ABOUT_LINK = 'About SkillBridge';
export const ANSWERED = {
	yes: 'SkillBridge steps added to your timeline. You can change this in Settings.',
	no: 'Got it. You can change this in Settings.'
};
export const CLOSE_LABEL = 'Dismiss SkillBridge message';
export function askAgainLine(day: string): string {
	return `We'll ask again on ${formatTimelineDate(day)}. You can change this in Settings.`;
}
export const ROW_LABEL = 'Planning SkillBridge';
export const ROW_SUMMARY: Record<PlanAnswer | 'none', string> = {
	none: 'Not answered',
	yes: 'Yes',
	'not-sure': 'Not sure',
	no: 'No'
};
export const ROW_UNAVAILABLE_SUMMARY = 'Unavailable';
export const ROW_UNAVAILABLE =
	"Your timeline progress could not be loaded, so this answer can't be changed right now. Reload the app to try again.";
export function rowHintEarly(day: string): string {
	return `Yes adds SkillBridge's steps to your timeline. Not sure asks again on ${formatTimelineDate(day)}.`;
}
export const ROW_HINT_LATE = "Yes or Not sure adds SkillBridge's steps to your timeline.";
