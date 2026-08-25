# CAIRN Fusion 0.6.6.1 — Multi-Provider field test

Open ChatGPT, Claude, and Gemini in separate refreshed tabs.

## Prompt-only test
1. Type `this will be a good test` in ChatGPT, but do not send.
2. Open CAIRN → Multi-Provider.
3. Choose `All open AI tabs` and leave both options OFF.
4. Click `Insert chat to…`.
5. Claude and Gemini should receive the draft without sending it.
6. Repeat with Claude as the source, then Gemini as the source.

The result line reports each target as `ChatGPT: ✓`, `Claude: ✓`, or `Gemini: ✓`.

## Context test
1. Open Brain and select one or more notes.
2. Return to Multi-Provider; the Brain selection is preserved.
3. Enable `Include selected Brain context`. A dark ✓ should appear.
4. Broadcast and verify the same context reaches each target.

## Attachment test
1. Enable `Attach selected .md`. A dark ✓ should appear.
2. Broadcast to target providers.
3. Attachment support is provider-controlled and remains best effort.

## Detach-all test
- `Brain → Detach all .md` removes every CAIRN-managed attachment from the current composer.
- `Multi-Provider → Detach all from…` removes every CAIRN-managed attachment from each targeted provider tab.
- Detach never deletes or changes vault files.
