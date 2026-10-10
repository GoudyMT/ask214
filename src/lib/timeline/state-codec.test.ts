import { describe, it, expect } from 'vitest';
import { encodeTimelineState, decodeTimelineState, TimelineSchemaError } from './state-codec';
import { readPlan, SKILLBRIDGE_PLAN_KEY } from './skillbridge-plan';
import { SNOOZE_DATE_MAX } from './snooze';
import type { TimelineState } from './types';

const dec = (json: string) => decodeTimelineState(new TextEncoder().encode(json));
const withTasks = (tasks: string) => `{"schemaVersion":1,"tasks":${tasks}}`;

describe('timeline-state codec', () => {
	it('round-trips state with schemaVersion inside', () => {
		const state: TimelineState = {
			schemaVersion: 1,
			tasks: { 'dd214-review': { status: 'done', notes: 'saved copies' } }
		};
		const back = decodeTimelineState(encodeTimelineState(state));
		expect(back).toEqual(state);
	});

	it('rejects non-JSON bytes', () => {
		expect(() => decodeTimelineState(new TextEncoder().encode('not json'))).toThrow();
	});

	it('rejects an unsupported schemaVersion', () => {
		expect(() =>
			decodeTimelineState(new TextEncoder().encode('{"schemaVersion":9,"tasks":{}}'))
		).toThrow();
	});
});

// A stored record the app cannot vouch for is never used as if it were good: what cannot be read is dropped so the
// task still shows, and what a newer release wrote (an unknown status or key) survives this tab's next write.
describe('timeline-state codec on a record it cannot vouch for', () => {
	it('throws a schema error when tasks is not a plain object', () => {
		for (const tasks of ['null', '[]', '"x"', '7', 'true', '[{"status":"done"}]']) {
			expect(() => dec(withTasks(tasks)), tasks).toThrow(TimelineSchemaError);
		}
		expect(() => dec('{"schemaVersion":1}')).toThrow(TimelineSchemaError);
	});

	it('keeps a task entry a release wrote, byte for byte', () => {
		const tasks = {
			a: { status: 'done' },
			b: { status: 'snoozed', snoozeUntil: '2026-11-15', notes: 'n' },
			c: { status: 'snoozed' },
			d: { notes: 'only a note' },
			e: { status: 'skipped' }
		};
		expect(dec(withTasks(JSON.stringify(tasks))).tasks).toEqual(tasks);
	});

	it('drops a status that is not a string and a note that is not a string, keeping the rest', () => {
		for (const bad of ['5', 'null', 'true', '["done"]', '{}']) {
			const tasks = dec(
				withTasks(`{"a":{"status":${bad},"notes":"keep"},"b":{"notes":${bad}}}`)
			).tasks;
			expect(tasks, bad).toEqual({ a: { notes: 'keep' } });
		}
	});

	it('keeps a status it does not know, so a newer release is not overwritten by this tab', () => {
		expect(dec(withTasks('{"a":{"status":"paused"}}')).tasks).toEqual({ a: { status: 'paused' } });
	});

	it('keeps a task key it does not know', () => {
		expect(dec(withTasks('{"a":{"status":"done","pinned":true}}')).tasks).toEqual({
			a: { status: 'done', pinned: true }
		});
		expect(dec(withTasks('{"a":{"pinned":true}}')).tasks).toEqual({ a: { pinned: true } });
	});

	it('drops an entry that is not a plain object, or that has nothing left', () => {
		const tasks = dec(
			withTasks('{"a":null,"b":[],"c":"done","d":7,"e":{},"f":{"status":5},"g":{"status":"done"}}')
		).tasks;
		expect(tasks).toEqual({ g: { status: 'done' } });
	});

	describe('a snooze date it cannot use', () => {
		const snoozed = (date: string) =>
			`{"a":{"status":"snoozed","snoozeUntil":${date},"notes":"keep"}}`;

		it('drops the date and the snoozed status as a pair, keeping the note', () => {
			for (const date of [
				'"10000-01-01"',
				'"2026-13-45"',
				'"3abcdefghi"',
				'"9999-12-31"',
				'"2026-02-30"',
				'"2026-12-01T00:00:00Z"',
				'20261201',
				'null',
				'{}'
			]) {
				expect(dec(withTasks(snoozed(date))).tasks, date).toEqual({ a: { notes: 'keep' } });
			}
		});

		it('keeps the date up to the latest one a snooze can name', () => {
			expect(SNOOZE_DATE_MAX).toBe('9999-12-30');
			expect(dec(withTasks(snoozed('"9999-12-30"'))).tasks).toEqual({
				a: { status: 'snoozed', snoozeUntil: '9999-12-30', notes: 'keep' }
			});
		});

		it('drops only the date when the status is not snoozed', () => {
			expect(dec(withTasks('{"a":{"status":"done","snoozeUntil":"2026-13-45"}}')).tasks).toEqual({
				a: { status: 'done' }
			});
		});

		it('drops a date that stands alone', () => {
			expect(dec(withTasks('{"a":{"snoozeUntil":"10000-01-01"}}')).tasks).toEqual({});
			expect(dec(withTasks('{"a":{"snoozeUntil":"2026-12-01"}}')).tasks).toEqual({
				a: { snoozeUntil: '2026-12-01' }
			});
		});

		// Dropping the date alone would turn a Not sure with a return date into a dateless Not sure, which shows the steps
		// nobody chose; the pair drop leaves no answer, so the card asks again.
		it('leaves a SkillBridge answer with a bad date reading as no answer', () => {
			const tasks = dec(
				withTasks(`{"${SKILLBRIDGE_PLAN_KEY}":{"status":"snoozed","snoozeUntil":"2026-13-40"}}`)
			).tasks;
			const read = readPlan(tasks[SKILLBRIDGE_PLAN_KEY], '2028-06-30', '2027-03-31');
			expect(read.answer).toBe('none');
			expect(read.stepsShow).toBe(false);
		});
	});

	describe('a task named __proto__', () => {
		const record =
			'{"schemaVersion":1,"tasks":{"__proto__":{"status":"done"},"a":{"status":"done"}}}';

		it('leaves no own __proto__ key and a plain prototype', () => {
			const { tasks } = dec(record);
			expect(Object.hasOwn(tasks, '__proto__')).toBe(false);
			expect(Object.getPrototypeOf(tasks)).toBe(Object.prototype);
			expect(Object.keys(tasks)).toEqual(['a']);
			expect(tasks['status' as string]).toBeUndefined();
		});

		it('leaves no own __proto__ key in a task entry either', () => {
			const { tasks } = dec(withTasks('{"a":{"status":"done","__proto__":{"status":"skipped"}}}'));
			const entry = tasks['a'] as object;
			expect(Object.hasOwn(entry, '__proto__')).toBe(false);
			expect(Object.getPrototypeOf(entry)).toBe(Object.prototype);
			expect(entry).toEqual({ status: 'done' });
		});

		it('keeps tasks named like Object.prototype members', () => {
			const tasks = dec(
				withTasks('{"constructor":{"status":"done"},"toString":{"notes":"x"}}')
			).tasks;
			expect(Object.keys(tasks).sort()).toEqual(['constructor', 'toString']);
		});
	});
});
