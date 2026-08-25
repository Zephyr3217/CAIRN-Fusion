# CAIRN Fusion 0.6.6.5 — Field Test

## Install / reload
1. Start `CAIRN.bat`.
2. Open `brave://extensions` and Reload CAIRN.
3. Refresh ChatGPT, Claude, and Gemini once.
4. Confirm CAIRN shows `Brain | Multi-Provider | Agent | Help`.

## A. Plain prompt replacement
1. In ChatGPT type `test me`.
2. CAIRN → Multi-Provider → All open AI tabs → **Insert / Sync**.
3. Claude and Gemini should contain only `test me`.
4. Change source to `test me now` and sync again.
5. Targets should contain only `test me now`, not both prompts.

## B. Automatic JPG transfer
1. Attach one JPG to the source composer.
2. Do not enable any transfer option; there is no transfer checkbox in 0.6.6.5.
3. Press **Insert / Sync**.
4. Target composers should receive the JPG automatically.
5. Replace it with another file and sync again; old target attachment state should be replaced.

## C. Automatic Markdown transfer
1. Remove the JPG from the source composer.
2. Attach one `.md` file manually.
3. Confirm Multi-Provider → **Current attachments** lists it as `✓ ready`.
4. Press **Insert / Sync**.
5. Verify ChatGPT/Claude/Gemini targets receive the `.md` file.

## D. Attachment-only sync
1. Clear source prompt text.
2. Leave only one attached file.
3. Press **Insert / Sync**.
4. The file should transfer even though the source draft is empty.

## E. Clear Targets
1. Sync text + files.
2. Press **Clear Targets**.
3. Target draft text should clear and CAIRN should attempt to remove all composer attachments.

## F. 30K inline-note guard
1. Brain → sort **Most text → least**.
2. Confirm each note card shows exact indexed characters and words.
3. Select a note over 30,000 characters and press **Insert**.
4. CAIRN must not paste/truncate/send it; it must recommend attaching the `.md` file.
5. Attach the note instead, then use Multi-Provider sync.

## G. Sync & Send All / Claude safety
1. Use a harmless prompt such as `Reply with one word: ready`.
2. Press **Sync & Send All**.
3. Confirm Claude sends the prompt and does not switch into temporary/incognito/private mode.
4. Confirm ChatGPT/Gemini also send.

## H. Reply notifications
1. Wait for each provider to finish.
2. On the currently active browser page, expect a centered red notice with white text such as `Claude has replied`.
3. Notice should disappear after about 1.8 seconds.

## I. Save Chat
1. Click **Save Chat**.
2. Test **Save Complete Chat**.
3. Test **Save Latest Chat**.
4. Test **Smart Save Latest Chat**; it should capture exactly one newest AI reply.
5. Use provider dropdown to capture ChatGPT/Claude/Gemini without changing tabs.
6. After entering the save-destination workflow, use the ← button to return to Save Chat.

## J. Tutorials
Confirm these buttons open in-panel tutorials:
- Brain → How to use Brain
- Multi-Provider → How to use Multi-Provider (below Clear Targets)
- Agent → How to use Agent
- Save Chat → How to use Save Chat
