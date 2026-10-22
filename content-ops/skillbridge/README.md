# SkillBridge data - the weekly run

The SkillBridge finder in the app reads static files served by a separate Cloudflare Worker,
`ask214-skillbridge-data`, on `ask214.com/skillbridge-data/*`. Those files are built here, on Max's PC, once a week,
from the public listings at `api.skillbridge.mil`, and deployed with Max's own Cloudflare login. Nothing in this
folder runs in the app or in CI except the tests.

What it keeps and why: facts only, never the providers' descriptions or contact names. The listings' contact
emails are published as DoD lists them; the built files and the pipeline's state hold real addresses, so neither is
ever committed: the deploy folder is git-ignored, and the state folder must lie outside the repo (the command refuses
one inside it).

## Before the first run (once)

1. Node 22 and the repo's packages installed (`pnpm install --frozen-lockfile`), and `pnpm check` run once, so
   `.svelte-kit/tsconfig.json` exists (the scripts' `$lib` imports need it).
2. Pick a state folder outside the repo, for example `C:/Users/Max/skillbridge-state`. It keeps last week's records,
   the provider list, pinned company sites, the removal-request list, the last two raw pulls and every report.
3. Build the supporting tables into it (public data: the Census ZCTA gazetteer and the O*NET Military Crosswalk,
   "Crosswalk Files by U.S. Department of Labor, Employment and Training Administration", CC BY 4.0 - credited in the
   app's About page and the finder footer):

   ```
   node --import tsx content-ops/skillbridge/tables.mjs --zcta <path>/2026_Gaz_zcta_national.txt --crosswalk <path>/milx0724.csv --out C:/Users/Max/skillbridge-state/tables
   ```

4. Log in to Cloudflare once, storing the token in Windows' credential store:

   ```
   pnpm exec wrangler login --use-keyring --scopes account:read user:read workers_scripts:write workers_routes:write zone:read
   ```

   then `pnpm exec wrangler whoami` shows the account and the scopes.

5. The first full pull is a baseline: add `--baseline` to the weekly command below, once. It sets every listing's
   first-listed date to that pull, so nothing is marked New, and it replaces any earlier records (the sample week
   included). A state folder that never had a baseline blocks every other run with `E_NO_BASELINE`.

## Every week

Run from the repo root (each command is one line):

1. Build the week:

   ```
   node --import tsx content-ops/skillbridge/run.mjs --state C:/Users/Max/skillbridge-state
   ```

   It asks `api.skillbridge.mil` one request at least 3 seconds after the last, names itself
   (`Ask214-skillbridge-finder (+https://ask214.com/about)`) and checks the server's robots.txt first. Run time:
   MEASURED ON THE FIRST FULL RUN (the plan's estimate is about 5.5 hours for a full sweep of every provider, so run
   it overnight; a weekly run asks only last week's providers and new ones unless the totals disagree).

   Exit codes: 0 - the week is written to `workers/skillbridge-data/deploy`; 2 - the pull stopped (see below);
   3 - the week was blocked by a check and nothing was written; 1 - a wrong argument or an unsafe setup (for
   example `E_STATE_INSIDE_REPO`, or `E_TLS_UNVERIFIED`: `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in the shell, which
   would switch off certificate checks - remove it and run again).

2. Read the report it prints (also saved as `runs/<date>/report.txt` in the state folder): the listing count beside
   the site's own total, how many providers were not proven complete, capped queries, rows held back and why,
   additions and removals, listings not seen this week, any provider whose count fell sharply, and the company
   website and LinkedIn link counts beside last week's (a sharp drop means a link source failed this week; run again
   later rather than deploy it).

3. If the report is right, deploy. From the data Worker's own folder, `workers/skillbridge-data`:

   ```
   node --import tsx ../../content-ops/skillbridge/deploy.mjs
   ```

   The guard checks the config (static files only, the one route, no code, no bindings), refuses to run from the repo
   root, with any `CLOUDFLARE_*`, `CF_*` or `WRANGLER_*` variable set in the shell, or beside a `.env` /
   `.env.local` file, checks that the deploy tree holds exactly the files the app may fetch (the zip and crosswalk
   tables included) and that each one is valid, and only then runs `wrangler deploy` with the data Worker's own
   config. Deploy every week you build: the deploy folder keeps this week and last week only.

## When the run stops

The pull stops at once, and nothing is published, on a robots.txt rule that disallows a request, a 403 or 429, a
CAPTCHA or other web page instead of data (whatever its status), a reply that is not the expected JSON, three errors
in a row, or a provider name that cannot be sent (`E_BAD_PROVIDER_NAME`: report it, it needs a code change). The app
keeps showing the last deployed week. Read the stop code in the report. Do not re-run the same night after a 403,
429 or robots stop; if the SkillBridge office objects to the pull in any way, stop running it and tell the office it
has stopped.

## When a week is blocked (exit 3)

- `E_DRIFT`: more than 20% of the listings were added or removed. Read the report; if the change is real, run again
  with `--accept-drift`.
- `E_INVALID_LISTING` or a file error: a listing or file failed the contract the app uses. Do not deploy; report it.
- `E_BASELINE_UNPROVEN`: a re-baseline when not every listing was accounted for. Run again later, or accept with
  `--accept-drift` after reading the report's count of providers not proven complete.
- `E_NO_BASELINE`: this state folder has never had a baseline; run with `--baseline` (step 5 above).
- `E_PULL_DATE_ORDER`: a run already happened today or later; nothing was asked. Run on a later day.
- `E_TABLES_MISSING`: `tables/zips.json` or `tables/crosswalk.json` is missing from the state folder; build them
  (step 3 above).
- `E_STATE_BEHIND_DEPLOY`: the deploy folder holds a later week than the saved state (the state save failed after
  the files were written). Do not deploy that folder; put back the state folder's copy from that week if you have
  one, or delete `workers/skillbridge-data/deploy` and run again.

## Missed weeks

Skipping a week is safe: the next run compares with the last run it saved, and a listing is only ever removed when
its provider's listings were all accounted for without it. Listings seen in neither week stay published as "not
seen" until proven gone.

## Rolling back

Cloudflare keeps the 100 most recent versions. Dashboard: "Workers & Pages" > `ask214-skillbridge-data` >
"Deployments" > the three-dot menu on the version to restore > "Rollback". Or from `workers/skillbridge-data`:
`pnpm exec wrangler versions list --config wrangler.jsonc`, then
`pnpm exec wrangler rollback <version id> --config wrangler.jsonc --message "<why>"`. Whether a rollback restores the
data files with the version: NOT YET MEASURED (to be read on the first rollback test).

## A removal request

When someone asks for their contact address to be removed (through Feedback), add the address to the `suppression`
list in `state.json` in the state folder (case and spacing do not matter), then run and deploy as usual: the address
is dropped from every listing, this week's and any kept from earlier weeks, roles and titles never carry an address,
and that week's deploy holds only the new week, so last week's files with the address are no longer served.

## Refreshing the tables

The Census gazetteer and the O*NET crosswalk change about once a year. Download the new files (each is a decision for
Max), run step 3 of "Before the first run" again, and run the week. The state boxes the clean step uses
(`src/lib/skillbridge-finder/contract/state-extents.ts`) are generated by the same script with `--counties <file>
--extents <that path>`; that file is committed, so a refresh of it is a normal change with its own pull request.
