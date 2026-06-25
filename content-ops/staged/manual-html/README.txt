MANUAL HTML CAPTURE  -  content-ops A2 ingest
=============================================

WHY THIS EXISTS
---------------
A few corpus sources sit behind Akamai bot-protection that blocks BOTH a plain
fetch AND a real headless browser (verified Session 31). We do NOT try to defeat
bot-protection - it is impolite and fragile. Instead, a human opens the PUBLIC
page once, saves its HTML, and the ingest engine reads that saved file like any
other capture. The pages are public; the block is bot-only, so a normal browser
sees the real content.

The same idea covers any future source that blocks automation (see "ADDING A
FUTURE BOT-BLOCKED SOURCE" at the bottom).


HOW YOU KNOW IT NEEDS DOING
---------------------------
Run `pnpm ingest`. If a manual file is missing, the run ends with:

    MANUAL CAPTURE NEEDED (N) -> full steps in content-ops/staged/manual-html/README.txt
        <source_id>:
            1. open <url>
            2. save the page as "HTML only" -> content-ops/staged/manual-html/<source_id>.html
            3. re-run `pnpm ingest`

That message IS your to-do list. Do the steps below for each one, then re-run
`pnpm ingest` - it skips everything already captured, so it is fast.


THE STEPS (do this for each source listed further down)
-------------------------------------------------------
1. Open the URL in a normal browser (Chrome / Edge / Firefox). You do NOT need to
   sign in - these are public pages.

2. VERIFY it is the real content, not a block or login page. Check ALL of:
       [ ] Real article / body text is visible (NOT "Access Denied").
       [ ] No CAC / PIV / login wall is required to read the content.
       [ ] It is the actual topic page - not a thin landing page that only links
           out to gated PDFs. If it is thin or empty, STOP and see "IF A PAGE HAS
           NO REAL PUBLIC CONTENT" below.

3. Save the page HTML:
       - Press Ctrl+S  (Cmd+S on Mac).
       - In the save dialog, choose "Webpage, HTML Only"  (NOT "Complete" - we do
         not want the images/css folder, only the HTML).
       - File name: EXACTLY  <source_id>.html  (the names are in the list below -
         no extra suffixes, no spaces).
       - Save into this folder:  content-ops/staged/manual-html/

4. Repeat for every source in the list.

5. Run `pnpm ingest` again. Each saved file should now show:
       PASS  <source_id>  (N chars)  [from saved HTML]
   If one still fails, re-open it and confirm the saved file is the real page
   (step 2), saved as "HTML Only" (step 3), named exactly right.


THE SOURCES TO CAPTURE
----------------------
(save each as the filename shown, into this folder)

  dfas_final_pay.html
      DFAS - Final Military Pay at Separation
      https://www.dfas.mil/militaryseparations/FinalPay/

  tsp_separation.html
      TSP - Leaving the Uniformed Services
      https://www.tsp.gov/changes-in-your-career/leaving-uniformed-services/

  navy_separation.html
      Navy - Enlisted Separations (MyNavyHR)
      https://www.mynavyhr.navy.mil/Career-Management/Personnel-Conduct-Sep/Enlisted-Separations/
      VERIFY CAREFULLY: this one may be a thin landing page that only points to
      CAC-gated MILPERSMAN PDFs. If there is no real PUBLIC body content, do NOT
      save it - skip it per the next section.


IF A PAGE HAS NO REAL PUBLIC CONTENT (blocked, CAC-gated, or just a thin shell)
------------------------------------------------------------------------------
Do NOT save a junk or empty file (that would poison the corpus). Instead, drop the
source cleanly:
    - remove its source_id from CAPTURE_MANUAL in content-ops/capture-extract.mjs, and
    - remove (or mark deferred) its entry in content/sources.yaml,
then note the reason in the session log. A corpus of fewer, real sources beats one
padded with empty pages.


ADDING A FUTURE BOT-BLOCKED SOURCE
----------------------------------
If a NEW source blocks both the plain fetch and the headless render:
    1. add its source_id to CAPTURE_MANUAL in content-ops/capture-extract.mjs,
    2. add a "save as <source_id>.html" line to THE SOURCES TO CAPTURE above (with
       its title + URL),
    3. follow THE STEPS.
The ingest reminder will then prompt for it automatically.


NOTES
-----
- These .html files are GITIGNORED (large, reproducible from the saved pages).
  Only this README is tracked, so the instructions travel with the repo.
- REFRESH (A5): manual sources cannot be auto-refreshed - a human must re-save on
  update. A5 should surface them in its manual review queue on a date/hash signal.
- The ingest records capture_method:"manual" in each extracted JSON, so it is
  always clear which sources came in by hand.
