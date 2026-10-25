// Client-only: the page starts a worker and reads document.visibilityState, neither of which exists on a server.
export const ssr = false;
export const prerender = false;
