# CAIRN Fusion 0.6.6.7 — Reply Notification Field Test

## Goal
Verify that reply-complete notifications are visible in the current/source AI tab and the other open supported AI tabs.

## Setup
1. Start `CAIRN.bat`.
2. Reload the CAIRN extension.
3. Refresh ChatGPT, Claude, and Gemini once.
4. Keep the three providers open in the same browser window.

## Test A — Sync & Send All
1. From one provider, type a short unique prompt.
2. Open CAIRN → Multi-Provider.
3. Press **Sync & Send All**.
4. Remain on the source tab.
5. As each provider finishes, confirm a centered notice appears such as `Claude has replied`.
6. Switch to the other provider tabs and confirm the same completion notices are visible there as well.

Expected:
- one notice per provider reply;
- no duplicated notices;
- translucent red background, white ~18 px text;
- visible for about 3.6 seconds;
- notification appears shortly after provider generation actually stops.

## Test B — Different source tab
Repeat from Claude, then Gemini, to confirm the source/current provider also sees completion notices from the other providers.

## Regression
Confirm Multi-Provider sync, Save Chat, Brain, Agent, attachment readiness, and target refresh still work as in 0.6.6.6.
