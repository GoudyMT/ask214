// PII route: client-only. Renders the user's EAOS-anchored timeline + decrypted per-task
// state (browser-only stores), so never server-rendered or prerendered (per-route ssr=false lock).
export const ssr = false;
export const prerender = false;
