// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	// The release version from package.json (vite.config.ts): plain text in the root layout, a constant anywhere else.
	const __APP_VERSION__: string;
}

export {};
