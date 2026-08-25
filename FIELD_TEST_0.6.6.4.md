# CAIRN Fusion 0.6.6.4 — Field Test

## 1. Compact launcher
With CAIRN connected, leave the mouse away from the controls.
Expected: CAIRN / Save Chat remain compact.
Hover either control or open CAIRN.
Expected: controls expand.

## 2. Draft replacement
Open ChatGPT + Claude + Gemini.
Type `test me` in one provider and Multi-Provider → Insert / Sync.
Change source draft to `test me now` and sync again.
Expected: targets contain only `test me now`, not both prompts.

## 3. Large Markdown inline guard
Create/select a Markdown note larger than 80,000 characters.
Brain → Insert.
Expected:
- nothing is inserted,
- no partial/truncated text,
- warning recommends Attach .md.

Repeat with Multi-Provider → Include selected Brain context.
Expected: no target is changed and nothing is sent.

## 4. Large Markdown as attachment
Brain → Attach .md for that same large note.
Then Multi-Provider → Transfer current attachments.
Expected: CAIRN attempts file transfer instead of inline pasting.

## 5. Context de-duplication
Sync selected Brain context to targets.
Edit only the source user prompt and sync again.
Expected: one CAIRN VAULT MEMORY block, not repeated copies.

## 6. Save Chat from another provider
Open CAIRN Save Chat.
Choose Claude / Gemini / ChatGPT or All open AI chats.
Test Complete Chat and Latest AI Reply.
Expected: capture appears in CAIRN save workflow without switching tabs.

## 7. Reply toast
Use Multi-Provider → Sync & Send All.
When a target finishes, expect a short notice such as `Claude has replied`.

## 8. Clear Targets
Sync text to targets, then use Clear Targets.
Expected: synchronized target draft text is cleared; detected attachment cleanup is attempted.
