# CAIRN Fusion 0.6.6.7 — Reliable Reply Notifications

CAIRN remains a local-first Markdown/SQLite bridge and Brain. This patch focuses on browser reliability across ChatGPT, Claude, Gemini, and other supported AI sites.

## 0.6.6.7 field fixes

- Multi-Provider waits up to 12 seconds for newly attached files to expose transferable bytes instead of failing immediately while the provider is still loading them.
- Current attachments update in real time and no longer treat filenames typed in the prompt as attached files.
- Each current attachment has a **Remove** control for detaching that one source file.
- Multi-Provider ↻ reloads only the selected target AI tabs, never the source tab, then rediscovers providers.
- Reply-complete notices are mirrored to supported AI tabs in the same browser window so the source chat can see when ChatGPT/Claude/Gemini finish.
- Save Chat → Inbox uses deterministic names: `NEIL-COMPLETE CHAT`, `NEIL-LATEST CHAT`, and `NEIL-SMART CHAT` (numeric suffixes are added automatically when needed).

## Multi-Provider

Open **CAIRN → Multi-Provider**. The current AI composer is the source of truth. **Insert / Sync** mirrors its current prompt text and every transferable attached browser file automatically. There is no `Transfer current attachments` checkbox and no `Include selected Brain context` checkbox. If you want Brain text, insert it into the source composer first; if you want a large note, attach the `.md` file instead.

**Sync & Send All** prepares targets first, waits for transferred attachment chips to finish loading on each provider, then sends. Send-button matching is provider-specific and rejects controls whose labels suggest temporary/incognito/private/mode actions.

## Brain size awareness

Each indexed note shows exact characters and words. Sort by name or text size. CAIRN blocks inline insertion when any selected note exceeds **30,000 characters** and recommends attaching the `.md` instead. It never truncates the note.

## Save Chat

Save Chat can capture from the current tab, ChatGPT, Claude, Gemini, another detected provider, or all open AI chats:

- **Save Complete Chat** — full visible conversation.
- **Save Latest Chat** — compatibility behavior from earlier CAIRN builds.
- **Smart Save Latest Chat** — exactly one newest assistant/model reply per selected provider.

Captured content enters the normal Inbox/Create/Append/Heading workflow. A back button returns to Save Chat.

## Reply notifications

After CAIRN-driven sends, a finished provider triggers a short centered red/white notice across supported AI tabs in the same browser window, including the source/current chat, e.g. `Claude has replied`.

## Help

Brain, Multi-Provider, Agent, and Save Chat each include a small in-panel tutorial. The main Help tab and dashboard Help remain available.

## Install

For an existing 0.6.6.6 installation, use the `0.6.6.6 → 0.6.6.7` patch and run its `.cmd` installer. Then restart `CAIRN.bat`, reload the extension at `brave://extensions`, and refresh open AI tabs once.

See `FIELD_TEST_0.6.6.7.md` for browser validation.


## 0.6.6.7 notification reliability

- Reliable cross-tab reply notifications use direct tab messages plus a storage-backed event bus, deduplicated by event id.
- Reply completion detection checks more frequently and notifies shortly after streaming/generation stops.
- Reply notices are centered, white-on-translucent-red, 18 px, and remain visible for about 3.6 seconds.
- The notification is mirrored across supported open AI provider tabs, including the source/current chat.
