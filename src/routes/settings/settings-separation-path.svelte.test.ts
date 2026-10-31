import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import SettingsPage from './+page.svelte';

const { store } = vi.hoisted(() => ({
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

function withPath(separationPath?: string): void {
	store.persona = {
		completeness: 'eaos-only',
		eaos: '2028-06-30',
		daysUntilSeparation: 600,
		...(separationPath ? { separationPath } : {})
	};
}

// What each save carried, read while it runs: the page wipes its copy of the bytes once a save settles.
const saved: Record<string, unknown>[] = [];
beforeEach(() => {
	saved.length = 0;
	store.save.mockReset().mockImplementation(async (patch: Record<string, unknown>) => {
		const p = patch.separationPath;
		saved.push({
			...patch,
			...(p instanceof Uint8Array ? { separationPath: new TextDecoder().decode(p) } : {})
		});
	});
	store.refresh.mockReset().mockResolvedValue(undefined);
});

const timelineSection = () => page.getByRole('region', { name: 'Transition timeline' });
const row = () => timelineSection().getByRole('button', { name: /how you are leaving/i });

describe('Settings, how the member is leaving', () => {
	it('sits in the timeline section after the SkillBridge row, with the saved answer', async () => {
		withPath('retirement');
		await render(SettingsPage);
		await expect.element(row()).toHaveTextContent('How you are leaving Retiring');
		const toggles = [...document.querySelectorAll('.settings-disclosure__toggle')].map(
			(b) => b.textContent ?? ''
		);
		const sb = toggles.findIndex((t) => /skillbridge plan|skillbridge\b/i.test(t));
		const path = toggles.findIndex((t) => t.includes('How you are leaving'));
		expect(path).toBeGreaterThan(sb);
	});

	it('saves a new answer as the profile field', async () => {
		withPath();
		await render(SettingsPage);
		await row().click();
		await timelineSection().getByRole('radio', { name: 'Leaving the Guard or Reserve' }).click();
		await timelineSection().getByRole('button', { name: 'Save', exact: true }).click();
		await vi.waitFor(() => expect(saved).toEqual([{ separationPath: 'reserve-component' }]));
	});

	it.each([
		[
			'Not sure yet',
			async () => {
				await timelineSection().getByRole('radio', { name: 'Not sure yet' }).click();
				await timelineSection().getByRole('button', { name: 'Save', exact: true }).click();
			}
		],
		[
			'Remove answer',
			async () => {
				await timelineSection().getByRole('button', { name: 'Remove answer' }).click();
			}
		]
	])('clears the stored answer with %s', async (_name, act) => {
		withPath('medical');
		await render(SettingsPage);
		await row().click();
		await act();
		await vi.waitFor(() => expect(saved).toHaveLength(1));
		expect('separationPath' in (saved[0] ?? {})).toBe(true);
		expect(saved[0]?.separationPath).toBeUndefined();
	});
});
