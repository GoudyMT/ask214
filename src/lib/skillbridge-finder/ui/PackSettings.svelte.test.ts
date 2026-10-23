import { render } from 'vitest-browser-svelte';
import { describe, it, expect, vi } from 'vitest';
import type { ComponentProps } from 'svelte';
import PackSettings from './PackSettings.svelte';

type Props = ComponentProps<typeof PackSettings>;

const off = (over: Partial<Props> = {}): Props => ({
	setupSummary: 'Near 21046, within 100 mi',
	held: null,
	offerBytes: 1_840_000,
	busy: false,
	onsave: vi.fn(),
	onremove: vi.fn(),
	...over
});

const on = (over: Partial<Props> = {}): Props =>
	off({ held: { bytes: 1_840_000, pullDate: '2026-10-21' }, ...over });

const button = (container: Element, text: string) =>
	[...container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text));

describe('PackSettings', () => {
	it('shows the setup, and says "Not set up" when there is none', async () => {
		const set = (await render(PackSettings, { props: off() })).container;
		expect(set.querySelector('h2')?.textContent).toBe('SkillBridge finder');
		expect(set.textContent).toContain('Your setup');
		expect(set.textContent).toContain('Near 21046, within 100 mi');
		const none = (await render(PackSettings, { props: off({ setupSummary: null }) })).container;
		expect(none.textContent).toContain('Not set up');
	});

	it('sends Change to the finder setup screen', async () => {
		const { container } = await render(PackSettings, { props: off() });
		const link = [...container.querySelectorAll('a')].find(
			(a) => a.textContent?.trim() === 'Change'
		);
		expect(link?.getAttribute('href')).toBe('/skillbridge#setup');
	});

	it('tells the size of the save before anything is saved, and saves on a tap', async () => {
		const props = off();
		const { container } = await render(PackSettings, { props });
		const save = button(container, 'Save for offline')!;
		expect(save.textContent?.trim()).toBe('Save for offline (about 1.8 MB)');
		expect(container.textContent).toContain('Off');
		expect(container.textContent).toContain(
			'Keeps the listings for your region, many-state and online programs on this device, encrypted, so the finder works without a signal. They update when you are online.'
		);
		save.click();
		expect(props.onsave).toHaveBeenCalledOnce();
	});

	it('offers no save while the size is not yet known', async () => {
		const { container } = await render(PackSettings, { props: off({ offerBytes: null }) });
		expect(button(container, 'Save for offline')).toBeUndefined();
		expect(container.textContent).toContain('Off');
	});

	it('says what is held and from when, and removes it on a tap', async () => {
		const props = on();
		const { container } = await render(PackSettings, { props });
		expect(container.textContent).toContain('On - 1.8 MB, from Oct 21, 2026');
		expect(button(container, 'Save for offline')).toBeUndefined();
		button(container, 'Remove')!.click();
		expect(props.onremove).toHaveBeenCalledOnce();
	});

	it('ignores a second tap on Save while one is running, and says it is busy', async () => {
		const props = off({ busy: true });
		const { container } = await render(PackSettings, { props });
		const save = button(container, 'Save for offline')!;
		expect(save.getAttribute('aria-busy')).toBe('true');
		expect(save.disabled).toBe(false);
		save.click();
		expect(props.onsave).not.toHaveBeenCalled();
	});

	it('ignores a second tap on Remove while one is running', async () => {
		const props = on({ busy: true });
		const { container } = await render(PackSettings, { props });
		const remove = button(container, 'Remove')!;
		expect(remove.getAttribute('aria-busy')).toBe('true');
		remove.click();
		expect(props.onremove).not.toHaveBeenCalled();
	});

	it('keeps its buttons at least 44 px tall', async () => {
		const { container } = await render(PackSettings, { props: off() });
		const controls = [...container.querySelectorAll('button, a')];
		expect(controls).toHaveLength(2);
		for (const el of controls) {
			expect(el.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
		}
	});
});
