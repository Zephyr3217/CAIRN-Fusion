# CAIRN Fusion 0.6.6.6 — Field Test

This field test targets the browser behaviors discovered during 0.6.6.5 testing.

## Preparation

1. Start `CAIRN.bat`.
2. Reload the unpacked CAIRN extension.
3. Refresh ChatGPT, Claude, and Gemini once.
4. Keep all three open in the same browser window.

## Test A — Real-time source attachment state

1. In the source composer, type a filename such as `TRANSFER.md` **without attaching a file**.
2. Open **CAIRN → Multi-Provider**.
3. **Current attachments must show `None`**. A filename typed in normal prompt text must not be treated as an attachment.
4. Attach a `.md`, JPG/PNG, PDF, or another normal file.
5. Current attachments should change from `loading…` to `✓ ready` automatically.
6. Remove the attachment in the provider UI. CAIRN should return to `None` without retaining a stale file name.

## Test B — Immediate sync while a file is still loading

1. Attach a file and immediately press **Insert / Sync**; do not wait manually.
2. CAIRN should display a waiting message while the source provider exposes the file bytes.
3. CAIRN should then synchronize automatically when the file is ready.
4. On each target provider, CAIRN must also wait for the transferred attachment chip/upload state before declaring that target ready.
5. If loading cannot complete within the safety timeout, CAIRN must stop without sending partial state.

## Test C — Remove one current attachment

1. Attach two different files to the source composer.
2. In **Current attachments**, press **Remove** beside only one file.
3. Only that source attachment should be detached.
4. The other attachment should remain listed and usable.

## Test D — Attachment-only sync

1. Clear all source prompt text.
2. Attach one file only.
3. Press **Insert / Sync**.
4. The file should transfer to selected target provider tabs without requiring any typed prompt.

## Test E — Target refresh button

1. Keep the source page on a recognizable scroll position/draft.
2. In Multi-Provider choose `All open AI tabs` and press `↻`.
3. The other detected AI provider tabs should reload.
4. The current/source page must **not** reload.

## Test F — Sync & Send All + reply notices

1. Type a harmless short test prompt in the source composer.
2. Press **Sync & Send All**.
3. Claude must not switch into Incognito/Temporary mode.
4. When a provider finishes, a centered red notification with white readable text should appear on supported AI tabs in the same browser window, including the source tab: e.g. `Gemini has replied`.

## Test G — Save Chat Inbox names

For each mode, capture a chat and choose **Save to Inbox**:

- Save Complete Chat → `CAIRN/Inbox/NEIL-COMPLETE CHAT.md`
- Save Latest Chat → `CAIRN/Inbox/NEIL-LATEST CHAT.md`
- Smart Save Latest Chat → `CAIRN/Inbox/NEIL-SMART CHAT.md`

If the filename already exists, CAIRN should add `(2)`, `(3)`, etc. rather than overwrite the older capture.

## Test H — Smart latest remains exactly one AI reply

1. Use a conversation with several assistant responses.
2. Choose **Smart Save Latest Chat**.
3. The capture should contain only the newest assistant/model response for that provider, not the previous 3–5 replies.

## Expected result

The main success criteria for 0.6.6.6 are: no stale attachment names from prompt text, no manual waiting before sync, target attachment uploads are allowed to finish before send, per-file source removal works, target refresh excludes the source tab, source-visible reply notifications work, and Inbox capture names are deterministic.
