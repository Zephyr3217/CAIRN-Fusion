## CAIRN Fusion 0.6.5 — Refinement pass

- No new features. A senior-maintainer audit of the real 0.6.4 source: kept
  every passing test (21/21), fixed two real bugs found while adding test
  coverage (a folder-deletion index leak, and a watcher race that could miss
  files created in the same instant as a brand-new folder), closed a token-in-
  URL exposure on the live-update stream, and fixed a live-confirmed
  inefficiency where every save broadcast three events instead of one.
  Full detail in CHANGELOG.md. Test suite: 21 -> 47.

## CAIRN Fusion 0.6.4 — Connection-aware browser UI

- On-page **CAIRN** and **Save Chat** controls stay hidden when the local CAIRN service is unavailable or the Bridge token is invalid.
- Selection-save and `[Note.md]` resolver UI are hidden while disconnected too.
- The extension checks connection state periodically; controls disappear if CAIRN stops and reappear if it returns with the same valid token.
- Saving/testing a valid Bridge token in the popup still automatically reloads the active page once.

# CAIRN Fusion Preview 0.6.3

## 0.6.3 patch

- **Brain + Agent are now one on-page CAIRN UI**, positioned beside Save Chat. Open CAIRN and switch between Brain, Agent, and Help tabs.
- Added a compact **browser tutorial / troubleshooting Help tab** plus expanded dashboard Help.
- Fixed the Context Space multi-select UI jump by replacing the native browser `prompt()` with an in-panel Save Space form. The panel remains viewport-locked while saving many selected notes.
- Setup now checks **Python 3.11+, pip, venv, and installed Python dependencies**, and gives clear instructions when a prerequisite is missing. Chrome/Brave/Edge are required only for the extension; Obsidian and Ollama remain optional.
- Ctrl+Shift+B opens the unified UI on Brain; Ctrl+Shift+A opens it on Agent.


## 0.6.2 patch

- Expanded **Claude.ai compatibility** for CAIRN UI mounting, Claude conversation extraction, and Claude/ProseMirror chat-box insertion.
- Brain note rows are still compact but no longer vertically clipped.
- Selected notes now show a filled **✓** marker plus a subtle selected-row highlight.
- Brain can **Attach .md** for all currently selected notes, including notes loaded from a Context Space.
- If Claude has not yet created its file input, CAIRN makes a best-effort attempt to open Claude's attachment control and explains what to do if the site still hides the uploader.


CAIRN 0.6 keeps the CAIRN local-first safety core and continues merging the most useful ZEPHRA workflows into the browser-first system.

**Core rule:** Markdown files remain the source of truth. SQLite is CAIRN's rebuildable index, search database, operation ledger, and Context Space/Thread store. Obsidian does not need to be running for normal CAIRN operations.

## What's new in 0.6


### Inbox is now a folder of separate notes
**Save to Inbox no longer appends into `CAIRN/Inbox.md`.** Every save creates a new Markdown note under `CAIRN/Inbox/`. Repeated titles are kept safely as `Title.md`, `Title (2).md`, `Title (3).md`, and so on. This applies to selections, full chats, and latest replies.


### Dashboard Quick Capture removed
The manual **Quick Capture** paste box has been removed from the local dashboard. CAIRN already has more direct capture paths: selection → Save to CAIRN, **Save Complete Chat / Latest Reply**, and Brain for vault → chat. The underlying Inbox API remains available to the browser Bridge, but the redundant dashboard paste UI is gone.

### Lighter Brain and simpler popup
The Brain panel is more compact: smaller but still readable text, tighter note rows, no horizontal scrollbar, and a shorter panel so the note list and Insert action stay visible with less scrolling. The extension popup no longer exposes Active Thread or the redundant `Brain / .md` button. Brain remains available from the on-page button and `Ctrl+Shift+B`.

### Threads are preserved but hidden from the everyday UI
A Thread was CAIRN's experimental idea for combining a Context Space (what AI may read) with a default write destination. It is not required for Brain or Bridge and was creating unnecessary UI weight, so 0.6 keeps the data capability for compatibility but removes it from the normal popup/Brain flow while we evaluate whether it is actually useful.

### Smarter, vault-aware CAIRN Agent
The Agent is no longer limited to exact command phrases. It understands natural variations such as:

- `history`
- `show history`
- `show recent changes`
- `what did we edit today?`
- `find my notes about SVM`
- `show my notes`
- `what is in [Thesis/Chapter 2.md]?`
- `status`
- `doctor`
- `undo last`
- `list spaces`

For unmatched questions CAIRN automatically searches the SQLite/FTS5 vault index instead of immediately replying "unknown".

If **Ollama is already running** and an installed local model is detected (Qwen, Gemma, Llama, Mistral, Phi, etc.), CAIRN may use that model to synthesize a grounded answer from vault search evidence. Ollama remains optional: save, patch, Brain, watcher, index, and Agent commands continue working without it.

### Complete chat capture — no highlighting required
A new persistent **Save Chat** browser button can capture:

- **Complete Chat** — all detected messages in the current AI conversation
- **Latest AI Reply** — only the latest detected assistant/model response

The captured conversation then enters the normal CAIRN destination flow:

- Save to Inbox (new note in `CAIRN/Inbox/`)
- Create New Note
- Append Existing Note
- Add Under Heading
- Patch Heading Body
- Raw Append

The extension popup and browser context menu also expose Complete Chat capture.

Current site-specific extraction targets ChatGPT, Claude, and Gemini first, with a generic article fallback. This needs real-browser field testing because these sites can change their DOM.

### Open / Attach Markdown
The Brain note list now has per-note:

- **Open .md** — inspect the raw Markdown in a CAIRN viewer
- **Attach** — attempt to attach the selected `.md` as a real Markdown file to the current AI chat

The Open .md viewer also provides:

- Insert into Chat
- Attach .md
- Download .md

Browser sites control their own file-upload UI, so direct attachment is best-effort. If the current site does not expose a compatible file input, CAIRN tells you to use Download .md or Insert into Chat instead.

The CAIRN dashboard's Indexed Notes and History now also include **Open .md**, alongside Open in Obsidian and Explorer.

### Dashboard Help
The local browser dashboard at:

```text
http://127.0.0.1:7821
```

now has a **Help** button covering Bridge, Complete Chat capture, Brain, `.md` handling, Agent examples, and safety behavior.

The extension popup also has **Dashboard + Help**.

## Features preserved from 0.4

### Brain
- sticky **Insert Selected Notes into Chat** footer
- Brain ON/OFF
- visual `.md` picker
- explicit `[Note.md]` resolver
- exact-path / unique-basename safety
- Context Spaces such as `@Thesis`
- exact context manifest insertion

### Bridge
- Save to Inbox
- Create Folder + Note
- semantic dated Append Existing Note
- dated Add Under Heading
- Patch Heading Body
- Raw Append

### Safety core
- OS filesystem watcher
- SQLite/FTS5 live index
- SHA-256 optimistic concurrency
- Markdown-it/CommonMark heading parsing
- atomic temp-file + fsync + replace
- history + Undo
- path traversal protection
- explicit Brain context only

## Windows setup

1. Extract the ZIP to a normal folder.
2. Run:

```bat
scripts\setup_windows.bat
```

3. Run:

```bat
CAIRN.bat
```

4. Open or let CAIRN open:

```text
http://127.0.0.1:7821
```

5. Connect a **test/copy** of your Obsidian vault first.

## Browser extension update

1. Open `chrome://extensions` (or the equivalent Chromium extensions page).
2. Remove/reload the older CAIRN extension.
3. Enable Developer Mode.
4. Choose **Load unpacked** and select `browser_extension` from this 0.6 folder.
5. Copy the current token from the CAIRN dashboard into the extension popup.
6. Refresh open ChatGPT / Claude / Gemini tabs.

Keyboard shortcuts remain:

- `Ctrl+Shift+S` — capture current selection
- `Ctrl+Shift+B` — Brain
- `Ctrl+Shift+A` — Agent

For a long conversation, use the green **Save Chat** button instead of highlighting everything.

## Data model

```text
Markdown files = canonical knowledge / source of truth
SQLite        = rebuildable index + search + history + spaces
```

CAIRN 0.6 does **not** switch to Omnexus's SQLite-as-canonical model.

## Automated verification

Run:

```bat
scripts\run_tests.bat
```

0.6 includes the previous safety/Brain/Fusion tests plus Agent tests proving natural phrases such as `history`, `show history`, natural SVM search, explicit `.md` reading, and note listing.

## Current limitations

Still intentionally incomplete compared with the long-term ZEPHRA + CAIRN fusion goal:

- site-specific Complete Chat extraction needs field testing against current ChatGPT/Claude/Gemini DOMs
- direct `.md` attachment depends on the target site's file-input implementation
- Ollama support is auto-detect/best-effort rather than a polished model-management UI
- no external Claude/Gemini/OpenAI API provider layer in Agent yet
- no image/PDF asset capture pipeline yet
- no polished per-folder capability grant editor yet
- no pairing-code UX yet
- no automatic Send interception for `[Note.md]`
- no packaged `.exe` installer yet

CAIRN always keeps deterministic/local functionality available when AI is missing.


## 0.6.2 live-refresh patch

- Saving a Context Space now immediately refreshes the open Brain Context Space dropdown and preselects the newly saved space. A full AI webpage reload is no longer needed.
- The Brain refresh button now refreshes both the live vault note index and Context Spaces in-place.
- Saving/testing a valid Bridge token in the extension popup now validates the token against CAIRN and automatically reloads the active browser page once so Bridge/Brain initialize with the new authorization.
