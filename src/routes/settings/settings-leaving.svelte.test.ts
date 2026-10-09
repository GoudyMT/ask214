import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
import { formatTimelineDate } from '$lib/timeline/format-date';
import {
	AFTER_SEPARATION,
	AFTER_SKILLBRIDGE,
	BEFORE_TERMINAL_LEAVE,
	ORDER_NOTE
} from '$lib/profile/leaving-copy';

// Days from the real clock: the page reads each typed date against the separation date and the other leaving date.
const { isoFromToday, store } = vi.hoisted(() => ({
	isoFromToday: (days: number) => {
		const d = new Date();
		d.setDate(d.getDate() + days);
		const pad = (n: number) => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	},
	store: {
		locked: false,
		clockBackward: false,
		persona: {} as Record<string, unknown>,
		save: vi.fn(),
		refresh: vi.fn()
	}
}));

vi.mock('$lib/profile/context', () => ({
	getProfileApp: () => ({
		status: 'ready',
		store,
		timeline: {
			ready: true,
			failed: false,
			locked: false,
			state: { schemaVersion: 1, tasks: {} },
			setStatus: vi.fn(),
			setSnooze: vi.fn(),
			refresh: vi.fn()
		},
		calendar: { ready: true, exclusions: { taskIds: [], categories: [] }, lastAdd: [] },
		byok: null,
		cause: null,
		wipeAll: null,
		relockAll: null
	}),
	setProfileApp: () => {}
}));
vi.mock('$lib/install/context', () => ({
	getInstallApp: () => ({
		canPrompt: false,
		installed: true,
		ios: false,
		persisted: true,
		promptInstall: async () => 'dismissed'
	}),
	setInstallApp: () => {}
}));

const SEPARATION = 200;
const STORED = 40; // the stored date the typed one is held against

function withLeaving(leaving: Record<string, unknown>): void {
	store.persona = {
		completeness: 'eaos-only',
		eaos: isoFromToday(SEPARATION),
		daysUntilSeparation: SEPARATION,
		leaving
	};
}

beforeEach(() => {
	store.save.mockReset().mockResolvedValue(undefined);
	store.refresh.mockReset().mockResolvedValue(undefined);
});

// The page has other Save buttons (the online key's), so the rows' own section is the scope.
const timelineSection = () => page.getByRole('region', { name: 'Transition timeline' });

async function enter(
	row: 'SkillBridge start' | 'Terminal leave start',
	iso: string
): Promise<void> {
	await timelineSection().getByRole('button', { name: row }).click();
	await page.getByLabelText(row).fill(iso);
	await timelineSection()
		.getByRole('button', { name: /^save$/i })
		.click();
}

describe('Settings, the SkillBridge and terminal leave dates in order', () => {
	// A terminal leave start typed 11 days before a saved SkillBridge start (Oct 8 against Oct 19), or on its day.
	it.each([
		['before', -11],
		['on', 0]
	])(
		'refuses a terminal leave start %s the SkillBridge start, and saves nothing',
		async (_, offset) => {
			withLeaving({ skillbridgeStart: isoFromToday(STORED) });
			await render(SettingsPage);
			await enter('Terminal leave start', isoFromToday(STORED + offset));
			await expect.element(page.getByText(AFTER_SKILLBRIDGE)).toBeVisible();
			expect(store.save).not.toHaveBeenCalled();
		}
	);

	// The same pair entered the other way round: terminal leave first, then a SkillBridge start on or after it.
	it.each([
		['after', 10],
		['on', 0]
	])(
		'refuses a SkillBridge start %s the terminal leave start, and saves nothing',
		async (_, offset) => {
			withLeaving({ terminalLeaveStart: isoFromToday(STORED) });
			await render(SettingsPage);
			await enter('SkillBridge start', isoFromToday(STORED + offset));
			await expect.element(page.getByText(BEFORE_TERMINAL_LEAVE)).toBeVisible();
			expect(store.save).not.toHaveBeenCalled();
		}
	);

	// A date that breaks both rules gets the separation line: no leaving date can be on or after separation at all.
	it('refuses a SkillBridge start on separation day and after terminal leave with the separation line', async () => {
		withLeaving({ terminalLeaveStart: isoFromToday(STORED) });
		await render(SettingsPage);
		await enter('SkillBridge start', isoFromToday(SEPARATION));
		await expect.element(page.getByText(AFTER_SEPARATION)).toBeVisible();
		expect(page.getByText(BEFORE_TERMINAL_LEAVE).query()).toBeNull();
		expect(store.save).not.toHaveBeenCalled();
	});

	it('saves a SkillBridge start the day before terminal leave, and a terminal leave start the day after SkillBridge', async () => {
		withLeaving({
			skillbridgeStart: isoFromToday(STORED),
			terminalLeaveStart: isoFromToday(STORED + 30)
		});
		await render(SettingsPage);
		await enter('SkillBridge start', isoFromToday(STORED + 29));
		await expect.element(page.getByLabelText('SkillBridge start')).not.toBeInTheDocument();
		await enter('Terminal leave start', isoFromToday(STORED + 1));
		await expect.element(page.getByLabelText('Terminal leave start')).not.toBeInTheDocument();
		expect(store.save.mock.calls.map(([patch]) => Object.keys(patch as object))).toEqual([
			['skillbridgeStart'],
			['terminalLeaveStart']
		]);
	});

	// A stored date on or after separation is not used, so it holds no other date back.
	it('saves a terminal leave start before a SkillBridge start that is not used', async () => {
		withLeaving({ notUsed: { skillbridgeStart: isoFromToday(SEPARATION + 50) } });
		await render(SettingsPage);
		await enter('Terminal leave start', isoFromToday(STORED));
		await expect.element(page.getByLabelText('Terminal leave start')).not.toBeInTheDocument();
		expect(store.save).toHaveBeenCalledTimes(1);
	});

	// A pair stored before the refusal existed, or brought into use when the separation date moved, keeps a note
	// whenever the refusal would turn it away, so the person can fix it.
	it.each([
		['out of order', -11],
		['on one day', 0]
	])('still notes a stored pair %s', async (_, offset) => {
		withLeaving({
			skillbridgeStart: isoFromToday(STORED),
			terminalLeaveStart: isoFromToday(STORED + offset)
		});
		await render(SettingsPage);
		await expect.element(page.getByText(ORDER_NOTE)).toBeVisible();
	});

	it('shows no note for a stored pair in order', async () => {
		withLeaving({
			skillbridgeStart: isoFromToday(STORED),
			terminalLeaveStart: isoFromToday(STORED + 1)
		});
		await render(SettingsPage);
		// The note renders with the rows, so once a row shows its date the note's absence is settled.
		await expect
			.element(timelineSection().getByRole('button', { name: 'Terminal leave start' }))
			.toHaveTextContent(formatTimelineDate(isoFromToday(STORED + 1)));
		expect(page.getByText(ORDER_NOTE).query()).toBeNull();
	});
});
