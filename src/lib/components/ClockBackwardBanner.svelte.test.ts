import { render } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import { describe, it, expect, vi } from 'vitest';
import ClockBackwardBanner from './ClockBackwardBanner.svelte';

describe('ClockBackwardBanner', () => {
	it('renders the locked backward-clock warning', () => {
		const { container } = render(ClockBackwardBanner, { props: { onfix: () => {} } });
		expect(container.querySelector('.clock-banner')).not.toBeNull();
		expect(container.textContent).toContain('moved backward');
	});

	it('fires onfix when "Fix this" is clicked', () => {
		const onfix = vi.fn();
		const { container } = render(ClockBackwardBanner, { props: { onfix } });
		const fix = container.querySelector<HTMLButtonElement>('.clock-banner__fix');
		expect(fix).not.toBeNull();
		fix?.click();
		expect(onfix).toHaveBeenCalledTimes(1);
	});

	it('hides itself when dismissed (reappears only on a fresh mount/reload)', async () => {
		const { container } = render(ClockBackwardBanner, { props: { onfix: () => {} } });
		container.querySelector<HTMLButtonElement>('.clock-banner__dismiss')?.click();
		await tick();
		expect(container.querySelector('.clock-banner')).toBeNull();
	});
});
