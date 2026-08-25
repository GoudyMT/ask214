// Client-only: the page reads the route-context stash from sessionStorage on mount, so there is
// no server render to mismatch during hydration.
export const ssr = false;
