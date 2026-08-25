# CAIRN Fusion 0.6.6.1

## Fixed
- Multi-Provider draft detection now accepts compact/single-line ChatGPT and Claude composers instead of rejecting them as too short to be visible.
- Provider-specific composer discovery now prioritizes real ChatGPT/Claude/Gemini message editors and prefers non-empty drafts.
- Remote insertion retries briefly and uses stronger ProseMirror/Lexical fallbacks, improving ChatGPT/Claude/Gemini cross-tab insertion.
- Plain prompt broadcasting no longer depends on selecting Brain notes; notes are only required when context or attachments are explicitly enabled.

## UX
- Multi-Provider Prompt is now a dedicated CAIRN tab: Brain → Multi-Provider → Agent → Help.
- Brain selections persist while switching between Brain and Multi-Provider tabs.
- Include Brain context / Attach selected .md now show a clear dark ✓ selected state.
- Multi-provider results report each target provider as ✓/✗ for easier diagnosis.
- Detach .md is now Detach all .md and removes every CAIRN-managed attachment in the current composer in one click.
- Multi-provider detach is now Detach all from… and removes all CAIRN-managed attachments from every targeted provider tab.

# CAIRN Fusion Changelog

## 0.6.6 — Multi-Provider Prompt + managed detach

### Added
- Brain **Multi-Provider Prompt** panel with dynamic discovery of other open supported AI tabs.
- Targets: All open AI tabs, ChatGPT, Claude, Gemini, plus any other supported provider currently detected.
- Optional selected Brain context injection before broadcast.
- Optional cross-tab selected `.md` attachment.
- `Detach .md` in Brain/current note view and cross-provider `Detach from…`.
- Conservative attachment tracking: detach targets CAIRN-managed filenames and never deletes the underlying Markdown note.

### Safety
- Broadcast is **insert-only**. CAIRN does not click Send/Submit in target providers.
- The current source tab is excluded from broadcast to avoid duplicating the prompt already typed there.
- No new broad `tabs` permission is required; provider discovery pings existing CAIRN content scripts.

### Compatibility
- Provider-specific DOM/file-upload behavior remains best effort. Prompt insertion may work on a provider even when its file attachment UI is not scriptable.

## 0.6.5 — Refinement pass (hardening, correctness, no new features)

This release intentionally adds zero user-facing features. It is a senior-maintainer
pass over the existing 0.6.4 implementation: read the real source end-to-end, kept
every passing test, fixed genuine bugs found while adding new test coverage for
gaps the project's own roadmap called out (watcher rename/delete, SQLite rebuild),
and hardened a few things that didn't need new complexity to harden.

### Fixed
- **"Undo last" could undo the wrong operation.** `operations.requested_at` has
  1-second resolution (`int(time.time())`). Two operations landing in the same
  wall-clock second — completely normal for a fast-capture tool, e.g. create a
  note then immediately patch a heading in it — sorted ambiguously under
  `ORDER BY requested_at DESC` alone, so "undo last" (and the Agent's `history`)
  could pick an older operation instead of the truly most recent one.
  Reproduced live end-to-end against a running server (create → patch →
  "undo last" returned `UNDO_CONFLICT` instead of reverting the patch), then
  fixed by adding `rowid DESC` as a tiebreaker everywhere operations are sorted
  by recency, and confirmed with the same live reproduction afterward.
  (`cairn/agent_engine.py`, `cairn/db.py`, `cairn/server.py`)
- **Folder deletion left phantom notes in the index.** Deleting a folder only
  cleared the `folders` table; any notes that had lived inside it stayed indexed
  in `notes`/`notes_fts` and kept appearing in search, Brain, and note pickers as
  entries pointing at files that no longer existed, until the next full re-index.
  `Database.remove_folder` now cascades to notes and the FTS shadow table under
  that prefix. (`cairn/db.py`)
- **Files created in the same instant as their parent folder could be missed by
  the watcher.** Recursive filesystem watching has an inherent short race: the
  watch on a brand-new subdirectory isn't guaranteed to be registered before
  files written into it in the same instant are visible to it (e.g. pasting a
  folder of notes in from a file manager, or `mkdir()` immediately followed by
  writes). Confirmed via a live reproduction, not just theory: creating a folder
  and two notes inside it back-to-back left both notes unindexed indefinitely.
  The watcher now does a bounded, one-time walk of a newly seen directory the
  moment it's noticed, closing the race without reintroducing periodic full-vault
  scanning. (`cairn/watcher.py`)
- **Stale install instructions.** `scripts/install_extension.txt` still described
  the pre-0.6 behavior where a capture was written to a single `CAIRN/Inbox.md`.
  Inbox has been a folder of separate notes since 0.6; the doc now says so.
- **Inconsistent version strings.** `cairn/__init__.py` said `0.1.0-msp`, the
  FastAPI app/health/bootstrap responses said `0.6.2`, the extension manifest
  said `0.6.4`. `__version__` in `cairn/__init__.py` is now the single source of
  truth, imported everywhere else that reports a version.

### Security
- **Constant-time Bridge token comparison.** `auth()` compared the token with
  `!=`, which is not constant-time. Switched to `hmac.compare_digest`. Low
  real-world severity for a loopback-only service, but a zero-risk, zero-cost fix.
- **Long-lived Bridge token no longer sits in the `/events` SSE URL.** Browser
  `EventSource` can't send custom headers, which is why the token was passed as a
  query parameter — but that means a secret with no expiry could end up in local
  browser history/logs indefinitely. `/events` now takes a short-lived (60s),
  single-purpose ticket minted via an authenticated `POST /api/events/ticket`
  call instead. Tickets are not single-use (an EventSource's automatic
  reconnect within the TTL window still works), and the ticket store prunes
  expired entries on every mint so it can't grow unbounded.
- **`config.json` (holds the Bridge token) is now `chmod 600`** on POSIX after
  every write. Best-effort; failures are swallowed rather than crashing CAIRN,
  and this is a no-op on Windows where the concept doesn't apply the same way.
- Reviewed and **did not change** `safe_resolve`'s traversal boundary — verified
  by direct testing (`tests/test_security.py`) that absolute-path joins,
  `../` sequences, and symlink escapes are all correctly rejected by the existing
  `is_relative_to()` check. Went looking for a real bug here and didn't find one;
  wrote regression tests instead of a fix that wasn't needed.
- Reviewed the default `CapabilityManager` grant (`**`/`**` for the browser
  extension) and **deliberately left it unchanged**: the project's own
  `BUILD_STATUS.txt` already lists a scoped pairing/grant-management UI as
  "not implemented yet." Tightening the default without a UI to grant broader
  access back would just break normal use for no real security gain yet.

### Performance
- **Every save no longer triggers three live-update broadcasts.** The atomic
  write's own temp file (`.{name}.cairn-...`) was visible to the watcher, so a
  single save produced a temp-created event, a temp-deleted event, *and* the
  real change event — tripling the work anything subscribed to `/events` (the
  dashboard) does per save. Confirmed via a live capture of the raw SSE stream
  before and after. The watcher now recognizes and ignores its own transient
  files.
- Best-effort `fsync` of the containing directory after an atomic replace, so
  the rename itself is durable across a crash immediately after, not just the
  file content written before it. POSIX only; a no-op on Windows.

### UX
- No visible UX changes in this release. (Deliberately — see "no new features"
  above.)

### Internal
- Migrated FastAPI startup/shutdown from the deprecated `@app.on_event` handlers
  to a `lifespan` context manager. Purely mechanical; removes a deprecation
  warning surfaced by installing against a current FastAPI, changes no behavior.
- Decoupled the browser content-script re-injection guard
  (`window.__CAIRN_FUSION_064__`) from a specific version number
  (`window.__CAIRN_FUSION_UI__`), so it doesn't need editing on every release.
- Removed committed `__pycache__`/`.pyc` artifacts from the package and added a
  `.gitignore`.
- Test suite grew from 21 to 47 tests, all added to cover gaps the project's own
  `BUILD_STATUS.txt` had already flagged as untested rather than to pad a number:
  real filesystem-watcher behavior (create/rename/delete, plus the two bugs
  above), path-traversal/symlink/capability-scope regression tests, SQLite
  index rebuildability, the new SSE ticket mechanism, and a few more Agent
  intent-phrasing variations.

### Known limitations
- Browser-side behavior (Brain UI, Complete Chat extraction selectors, connection-
  aware control hide/show, Context Space live refresh) was read carefully and
  left untouched — it looked sound, but this environment cannot load a real
  Chrome/Claude/ChatGPT/Gemini session, so none of it was exercised live. Treat
  it as reviewed, not verified, this round.
- The default browser capability grant is still effectively full-vault
  (`**` read/write). Fine for a single local user with no grant-management UI
  yet; worth revisiting once/if a real pairing flow exists.
- `server.py`'s route handlers still return raw Python exception text in error
  responses (`except Exception as e: raise HTTPException(400, str(e))`) across
  ~15 endpoints. Left alone this round — low severity for a loopback-only,
  single-user tool, and cleaning it up everywhere would be a wide, low-value
  diff for a "polish, don't churn" pass.

---

## 0.6.4 and earlier

See `BUILD_STATUS.txt` for the pre-0.6.5 development history (0.6 → 0.6.4).
