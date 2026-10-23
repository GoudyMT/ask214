// The finder holds where the person is looking and what they saved, decrypted in browser-only stores, so the page is
// never server-rendered or prerendered: the shell the service worker caches stays empty of anything personal.
export const ssr = false;
export const prerender = false;
