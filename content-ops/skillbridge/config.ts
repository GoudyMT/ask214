/**
 * The fixed settings of the weekly SkillBridge pull. The pull reads a public server we do not run, from Max's own
 * PC, so every number here leans toward being gentle and toward keeping a listing rather than wrongly removing it.
 */

/** The one host the pull may ask; every request URL is built on it, never on a value from a response. */
export const API_ORIGIN = 'https://api.skillbridge.mil';
export const ROBOTS_PATH = '/robots.txt';
export const FILTERS_PATH = '/Location/Filters';
export const LOOKUP_PATH = '/Location/Lookup';

/** Names the project and leads a server operator to the Feedback form. */
export const USER_AGENT = 'Ask214-skillbridge-finder (+https://ask214.com/about)';

/** At least this long between the starts of two requests. */
export const PAUSE_MS = 3_000;
/** After an error the next try waits PAUSE_MS * 2^n, where n is the errors in a row so far (6 s, 12 s). */
export const BACKOFF_BASE_MS = 3_000;
/** This many errors in a row stop the run. */
export const MAX_ERRORS_IN_A_ROW = 3;
/** A request still unanswered after this long counts as an error. */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The server returns at most this many rows for any query, and paging past it returns none: a query whose
 * filtered count reaches it is capped and must be split.
 */
export const LOOKUP_CAP = 150;
/** The three delivery method ids: the first split for a provider past the cap (a clean partition). */
export const DELIVERY_SPLIT = [1, 2, 3] as const;

/** Additions or removals past this share of last week's published total stop the publish unless accepted. */
export const DRIFT_LIMIT = 0.2;
/** A provider whose seen ids fell below this share of last week's count is named in the report. */
export const PROVIDER_FLOOR_RATIO = 0.5;
/** Providers this small are not named by the floor: a drop from 2 to 0 is normal churn. */
export const PROVIDER_FLOOR_MIN = 4;
/** A first sighting is New only when its creation date is at most this many days before the pull. */
export const NEW_WINDOW_DAYS = 30;

/** The company-site check: one GET of a home page, cut short on any of these. */
export const SITE_TIMEOUT_MS = 10_000;
export const SITE_MAX_BYTES = 512 * 1024;
export const SITE_MAX_REDIRECTS = 3;

/** The Wikidata query service, the only other host the pipeline asks (CC0 data, exact name match). */
export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql';
export const WIKIDATA_BATCH = 60;
export const WIKIDATA_PAUSE_MS = 1_500;

/** The deploy tree, relative to the data Worker's assets directory; it mirrors the request path. */
export const DEPLOY_DATA_DIR = 'skillbridge-data';
/** Dated folders kept in the deploy tree: this week's and last week's. */
export const DEPLOY_WEEKS_KEPT = 2;
/**
 * The Unicode version of the Node that may run the weekly command (`process.versions.unicode`). The clean step strips
 * code points unassigned in it; another version would change what is published, so the run refuses to start until
 * this is updated in a reviewed change.
 */
export const UNICODE_VERSION = '17.0';
/** Cloudflare's static-asset limits per Worker version. */
export const ASSET_MAX_FILES = 20_000;
export const ASSET_MAX_FILE_BYTES = 25 * 1024 * 1024;

/**
 * The data Worker serves its files with its own headers: it does not inherit the app's `_headers`. Every file
 * is fetched fresh (a week-old index would point at files no longer deployed), and each carries the app's
 * security headers.
 */
export const DATA_HEADERS_FILE = [
	'/skillbridge-data/*',
	'  Cache-Control: no-store',
	'  Strict-Transport-Security: max-age=63072000; includeSubDomains; preload',
	'  X-Content-Type-Options: nosniff',
	'  Referrer-Policy: no-referrer',
	'  Cross-Origin-Resource-Policy: same-origin',
	"  Content-Security-Policy: default-src 'none'",
	'  X-Robots-Tag: noindex',
	''
].join('\n');
