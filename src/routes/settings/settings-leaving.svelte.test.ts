import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';
import { formatTimelineDate } from '#lib/timeline/format-date.js';
import { AFTER_SEPARATION, ORDER_NOTE } from '#lib/profile/leaving-copy.js';

// Days from the real clock: the page reads each typed date against the separation date.
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

vi.mock('#lib/profile/context.js', () => ({
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
		relockAll: null,
		joinRelock: null,
		publish: null,
		reloadOnUnlock: false,
		replacedNotice: false
	}),
	setProfileApp: () => {}
}));
vi.mock('#lib/install/context.js', () => ({
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

describe('Settings, the SkillBridge and terminal leave dates in either order', () => {
	// Some services put SkillBridge before terminal leave and some do not, so the app saves either order: a terminal
	// leave start typed 11 days before a saved SkillBridge start (Oct 8 against Oct 19), or on its day.
	it.each([
		['before', -11],
		['on', 0]
	])('saves a terminal leave start %s the SkillBridge start', async (_, offset) => {
		withLeaving({ skillbridgeStart: isoFromToday(STORED) });
		await render(SettingsPage);
		await enter('Terminal leave start', isoFromToday(STORED + offset));
		await expect.element(page.getByLabelText('Terminal leave start')).not.toBeInTheDocument();
		expect(store.save.mock.calls.map(([patch]) => Object.keys(patch as object))).toEqual([
			['terminalLeaveStart']
		]);
	});

	// The same pair entered the other way round: terminal leave first, then a SkillBridge start on or after it.
	it.each([
		['after', 10],
		['on', 0]
	])('saves a SkillBridge start %s the terminal leave start', async (_, offset) => {
		withLeaving({ terminalLeaveStart: isoFromToday(STORED) });
		await render(SettingsPage);
		await enter('SkillBridge start', isoFromToday(STORED + offset));
		await expect.element(page.getByLabelText('SkillBridge start')).not.toBeInTheDocument();
		expect(store.save.mock.calls.map(([patch]) => Object.keys(patch as object))).toEqual([
			['skillbridgeStart']
		]);
	});

	// The range runs back 5 years as well as forward 15, so the message names both ends: a year typo into the past
	// was told "within about 15 years from today", which it already was.
	it('names both ends of the range when a date is too far back, and saves nothing', async () => {
		await render(SettingsPage);
		await enter('SkillBridge start', isoFromToday(-6 * 365));
		await expect
			.element(page.getByText('Enter a date from 5 years ago to 15 years from now.'))
			.toBeVisible();
		expect(store.save).not.toHaveBeenCalled();
	});

	// The store keeps its own copy, so the bytes of the typed date are wiped once the save settles.
	it('zeroes the typed date it handed to the store once the save settles', async () => {
		withLeaving({ skillbridgeStart: isoFromToday(STORED) });
		await render(SettingsPage);
		await enter('Terminal leave start', isoFromToday(STORED + 5));
		await expect.element(page.getByLabelText('Terminal leave start')).not.toBeInTheDocument();
		const [patch] = store.save.mock.calls[0] as [{ terminalLeaveStart: Uint8Array }];
		expect(patch.terminalLeaveStart.length).toBeGreaterThan(0);
		expect(patch.terminalLeaveStart.every((b) => b === 0)).toBe(true);
	});

	// No leaving date can be on or after separation, whatever the other date is.
	it('refuses a SkillBridge start on separation day, and saves nothing', async () => {
		withLeaving({ terminalLeaveStart: isoFromToday(STORED) });
		await render(SettingsPage);
		await enter('SkillBridge start', isoFromToday(SEPARATION));
		await expect.element(page.getByText(AFTER_SEPARATION)).toBeVisible();
		expect(store.save).not.toHaveBeenCalled();
	});

	// A pair with SkillBridge on or after terminal leave keeps a note, so the person checks their service's guidance.
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
			.toMatchTextContent(formatTimelineDate(isoFromToday(STORED + 1)));
		expect(page.getByText(ORDER_NOTE).query()).toBeNull();
	});
});
