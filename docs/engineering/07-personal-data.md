# Personal Data: Engineering Decisions

## Overview

The profile, the timeline built from it, the user's task notes, their calendar choices and an optional API key
stay on the device, encrypted in IndexedDB. There is no account and no server copy. This document covers how
that data is stored, encrypted, locked, shared between tabs, kept and erased, and the two ways any of it
leaves: a calendar file the user saves, and the API key, sent only to its own provider with each summary
request. Each decision's full reasoning is kept in private working notes.

## Stack at a Glance

| Layer      | Tool                        | Version  | Purpose                                 |
| ---------- | --------------------------- | -------- | --------------------------------------- |
| Storage    | IndexedDB, raw API          | spec     | Eight single-row stores                 |
| Encryption | Web Crypto, AES-GCM 256     | spec     | Every personal record                   |
| Integrity  | Web Crypto, HMAC-SHA-256    | spec     | Signs the key record and rollback marks |
| Keys       | Non-extractable `CryptoKey` | spec     | Made on the device, never exportable    |
| Ordering   | Web Locks API               | spec     | Orders writes; erase goes last          |
| Tabs       | BroadcastChannel            | spec     | Tells other tabs to read again          |
| Export     | iCalendar file              | RFC 5545 | Deadlines into the user's own calendar  |

## Decisions and Reasoning

### What is stored, and where

**What it is.** The profile holds the separation date (EAOS) and, optionally, rate, rank, years of service,
anticipated disability rating, family status, intended path, destination, special situations, and SkillBridge
and terminal leave start dates. Beside it are the timeline's task statuses, snooze dates and notes, among them
the answer to the SkillBridge question, the calendar choices, and the optional API key. Each lives as
ciphertext in its own single-row IndexedDB store; three more stores hold signed rollback marks and one holds the
keys, eight in all. Pages that show personal data render only in the browser, and a CI test fails if any server
file names a profile field.

**Why this project uses it.** With no server copy, there is nothing to breach, sell or hand over.

**Tradeoffs accepted.** No sync between devices and no backup. Clearing the site's data loses it all.

---

### Encryption at rest

**What it is.** Every record passes through one function, `encryptRecord` (`src/lib/crypto/record-crypto.ts`):
AES-GCM with a 256-bit key, a fresh random 12-byte IV for each write and a 128-bit tag. The additional
authenticated data binds the ciphertext to its store, record, write generation, schema version and key record,
so a record moved to another slot, replayed from an older write or paired with another key record fails to
decrypt. A project lint rule forbids writing to an encrypted store anywhere else.

**Keys.** On first run the browser generates an AES-GCM 256 key and an HMAC-SHA-256 key as non-extractable
`CryptoKey` objects, which no script can export, and stores them with the signed key record in one
transaction. Signed high-water marks beside the profile, timeline and calendar records refuse an older copy, and
errors carry opaque codes, never decrypted text.

**What it does not protect.** There is no passphrase yet, so the key sits on the same device as the data.
Non-extractable keys and authenticated encryption stop the key being exported and the records being altered or
swapped, but not someone using the unlocked browser. A passphrase is planned for a later version.

**Tradeoffs accepted.** One key for everything, so losing the database loses the key and the data together.

---

### Locking and memory

**What it is.** After 15 minutes without input, or when the user taps Lock in Settings, the app drops the
decrypted profile from memory. Its text fields are held as bytes, so they are overwritten rather than left for
the garbage collector. Unlock decrypts again, and a lock the user asked for is never undone silently. Pages that
hold personal data send `Cache-Control: no-store`, so the back-forward cache cannot bring them back. Logs pass
through one sink that refuses error objects and keeps 64 entries in memory only; direct console use is a lint
error.

**Tradeoffs accepted.** Without a passphrase, Unlock is one tap: the lock clears the screen, it is not access
control. Timeline notes and the calendar record are not overwritten in memory like the profile.

---

### Several tabs

**What it is.** Writes take Web Locks: ordinary writes share the key lock, profile writes go one at a time, and
erase takes the key lock alone. After writing, a tab posts a bare event over BroadcastChannel; the others
read again from IndexedDB, a hidden one starting only when shown, and a lock in one tab locks the others. A tab
still on an older version steps aside when a newer tab upgrades the database, and asks the user to reload.

**Tradeoffs accepted.** The channel is not authenticated, but its events carry no data, so a forged one (which
needs code already on the site) can at most cause an extra read or a lock. Without BroadcastChannel, other tabs
do not update live.

---

### Keeping the data

**What it is.** Losing the database loses the key with it, so the app asks the browser for persistent storage
(`navigator.storage.persist()`) at load and again on install, and the home page suggests installing it. In
Safari, being installed exempts a site from clearing after seven days without a visit, and granted persistence
exempts it from clearing under storage pressure.

**Tradeoffs accepted.** Persistence is the browser's decision, an uninstalled Safari tab can still be cleared
after seven days, and these exemptions are untested on a real iPhone.

---

### Erase

**What it is.** Erase, in Settings after a confirmation, runs in one safe order: decrypted data leaves memory
first; then all eight stores are cleared in one transaction while erase holds the key lock alone, so no save in
progress can write a row back; then local storage and every cache, saved documents included; then a reload into
a fresh first run. It refuses to start unless it can clear every store, and if it stops, it says nothing was
deleted.

**Tradeoffs accepted.** Erase removes the saved documents too, so they download again on the next save.

---

### The timeline and the calendar file

**What it is.** The timeline is computed on the device: 37 task definitions with day offsets from the
separation date, each shown only when the profile is known to meet its conditions. Two of them, finding a
SkillBridge program and submitting the request, show only after the sailor answers Yes to the Timeline's
SkillBridge question, or Not sure when it asks a second time. Each window has a firmness:
soft (good timing only), required until separation, closing for good, or changing how it works. Each task also
names what it must finish before: separation, terminal leave, or leaving the command (SkillBridge or terminal
leave, whichever starts first). Once that date is entered, the last day moves to the day before it if earlier,
while the opening stays, so every date keeps its source; the separation package and DD-214 review count their
whole window from it. A device clock that jumps back over a day shows a warning rather than quietly reshuffling
deadlines. The export is an `.ics` file the user saves, named by the day of the add: an all-day event for each
moment still ahead (a window opening, a change in how a window works, a last day, the last day before leaving the
command for a task that cannot fit there, or a soft task's target date), with alerts before each firm date and
target date, never an event before today. Events and alerts carry only a stable ID, the date and the
task's title with its moment, never notes or profile details, though the dates can reveal the separation and
leaving days, and the two SkillBridge steps reveal that the sailor plans SkillBridge. Stable IDs and a rising
version number let an app that honors them update events rather than duplicate them. Not every app does, so the
calendar record keeps each event handed over (task, moment, title, date and day of the add), and after a change
Settings lists the ones to delete until the user marks them deleted.

**Tradeoffs accepted.** Export is one way, so a change means exporting again. Each calendar app decides whether
to keep the alerts. Google Calendar sync is designed but not built.

## How These Pieces Fit Together

Every personal record goes through one encryption function into IndexedDB, bound to its place and write. Locks
order writes across tabs, the idle lock clears memory, persistence resists eviction, and erase leaves no row
behind. Only a calendar file the user saves and the API key, sent to its own provider, ever leave.

## Standards Adopted in This Section

- **Stored personal data never leaves the device**, except in a file the user saves.
- **One encryption function**, enforced by a lint rule.
- **Non-extractable keys**, made on the device.
- **Fail closed:** a record that does not verify is not used.
- **State the limits:** without a passphrase, the device is the boundary.

## Further Reading

- Web Crypto API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
- AES-GCM (NIST SP 800-38D): https://csrc.nist.gov/pubs/sp/800/38/d/final
- IndexedDB: https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API
- Web Locks API: https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API
- Storage persistence: https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- iCalendar (RFC 5545): https://www.rfc-editor.org/rfc/rfc5545

## Revision Notes

- 2026-10-02: First draft.
- 2026-10-05: The leaving dates and the record of handed-over calendar events.
- 2026-10-09: Every calendar moment named.
