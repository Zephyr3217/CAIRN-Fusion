# CAIRN Fusion 0.6.6.3 — Field Test

Open ChatGPT, Claude, and Gemini, reload CAIRN, and refresh each AI tab once.

## UI

Expected floating controls:

1. Multi-Provider
2. CAIRN
3. Save Chat

CAIRN panel should contain only Brain / Agent / Help.

## Test 1 — Prompt replacement

Source: ChatGPT

1. Type `test me`.
2. Multi-Provider → Insert / Sync.
3. Confirm Claude and Gemini show only `test me`.
4. Change source to `test me now`.
5. Insert / Sync again.
6. Confirm targets contain only `test me now`, not both drafts.

## Test 2 — Attachment-only

1. Clear the source draft completely.
2. Attach one image/PDF/.md/doc file.
3. Open Multi-Provider.
4. Confirm Current attachments shows the filename.
5. Enable Transfer current attachments.
6. Insert / Sync.
7. Confirm targets receive the file even though the source has no text.

## Test 3 — Replace old target attachments

1. Sync File A.
2. Remove/change the source attachment to File B.
3. Sync again.
4. Targets should contain File B only. File A should be removed.

## Test 4 — One-shot Brain .md

1. Brain → select one .md.
2. Multi-Provider → enable Attach selected .md.
3. Insert / Sync.
4. Reopen Brain: expected 0 notes selected.
5. Multi-Provider: expected Attach selected .md OFF.

## Test 5 — Detach all

Attach multiple file types in a target composer, then use Detach all files/current target detach. CAIRN should remove all detected attachments in one operation.

## Test 6 — Sync & Send all

Use a harmless short prompt. Select Sync & Send all only when you intentionally want CAIRN to submit the source + selected target chats. Confirm it does not trigger from normal Insert / Sync.
