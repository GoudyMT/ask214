// The home page IS the Ask front door: it embeds + searches on-device (a worker + the corpus), so it
// is never server-rendered or prerendered - matching the config the /ask route carried before it moved.
export const ssr = false;
export const prerender = false;
