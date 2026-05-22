# Military Transition Companion

> A privacy-first Progressive Web App helping US transitioning service members navigate the ~24-month period before and after separation. Currently in design phase. Built by a US Navy veteran, solo + AI-augmented.

**Status:** Phase 0 - Foundation. Design spec complete, governance system established, v1.0 implementation plan next.

---

## What This Is

The mobile-app layer for transitioning service members is effectively vacant - Military.com's Transition App was silently discontinued circa 2017-2018, and no replacement consolidates timeline + reference + community in one place. This project fills that gap with:

1. **Persona-aware EAOS-anchored timeline** with deep Google + Apple Calendar integration
2. **Consolidated, locally-searchable reference library** of public TAPS curriculum, VA pamphlets, branch instructions, SkillBridge guidance (retrieval-with-citations as the floor; online generative synthesis with citations as the ceiling in v1.1+)
3. **Curated peer-story layer** threaded to specific timeline tasks (v1.3)

Plus a deep SkillBridge module (v1.2) and cautious VA-tool outbound linking (never recreating official tools; always linking with context).

---

## Status

- [x] Market and competitive landscape research
- [x] Master design spec (vision + roadmap v1.0->v3.x + architecture + components + privacy + content + risk register)
- [x] Project governance system established (multi-session continuity, working standards, templates)
- [ ] v1.0 implementation plan (in progress)
- [ ] v1.0 code build (~4-5 months solo, starts after plan locked)

**See [`_Master Roadmap.md`](\_Master Roadmap.md) for the full versioned plan.**

---

## For Collaborators / AI Agents

**New session? Read [`_Start Here.md`](\_Start Here.md) first.** It directs you to the working standards, current state, and resume point.

---

## Project Principles

- **Privacy and security ABOVE all else** - PII stays on the user's device by default. No third-party trackers. No ads, ever.
- **Open source** - public code, public sources index, no hidden behavior. License TBD (AGPL-3.0 or MIT).
- **Free** - donation-supported from v1.1; no paywalls, no upsells, no premium tier.
- **Veteran-built** - the author lived this transition. The product credibility starts there.
- **Accurate, not impressive** - retrieval-with-citations over confident-sounding generation. Outbound to official tools for anything affecting benefits or money.
- **Solo + sustainable** - versioned roadmap with honest scope per version. No "all 6 branches at once."

---

## Project Structure

```
Military Transition App/
  _Start Here.md                  <- New session entry point
  _Working Standards.md           <- Methodology, code/security/test standards
  _Working Memory.md              <- Dashboard + session index + key decisions
  _Active Plan.md                 <- Current focus
  _Master Roadmap.md              <- Full version roadmap v1.0->v3.x
  _Session Log.md                 <- Chronological history
  AGENTS.md                       <- Durable handoff for any AI tool
  README.md                       <- THIS FILE
  _Research/                      <- Landscape + governance research artifacts
  _Templates/                     <- Session log, ADR, component spec, security checklist
  docs/
    superpowers/specs/            <- Master design spec
    decisions/                    <- Architecture Decision Records (MADR)
    plans/                        <- Per-version implementation plans
  content-ops/                    <- Content scraping pipeline (when started)
  src/                            <- PWA source (when v1.0 build starts)
  tests/                          <- E2E + integration tests
```

---

## License

TBD - currently choosing between AGPL-3.0 and MIT. See [`_Working Memory.md`](\_Working Memory.md) Open Decisions.

---

## Contact

TBD - domain not yet registered.

---

## Not Affiliated With

This project is independent and NOT affiliated with the US Department of Defense, Department of Veterans Affairs, or any branch of the US military. All ingested content is public US Government work product (per 17 USC 105) or used under properly attributed license. We do not provide legal, financial, or medical advice. We do not assist with VA claims or charge for claims-related services. For official benefits guidance, contact a VA-accredited Veteran Service Organization (DAV, VFW, American Legion, etc.) or va.gov.
