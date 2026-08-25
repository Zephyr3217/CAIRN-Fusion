# CAIRN Fusion 0.6.6.2 — Field Test

Open ChatGPT, Claude, and Gemini and refresh each once after reloading the extension.

## 1. Replacement sync
1. In one provider type `test me`.
2. Multi-Provider → **Insert chat to…**.
3. Confirm targets contain exactly `test me`.
4. Change the source draft to `test me now`.
5. Run **Insert chat to…** again.
6. Confirm targets contain only `test me now`, not both drafts.

## 2. Send all
Type a harmless test prompt. Click **Insert & Send all**. The current source chat and all selected target tabs should submit once.

## 3. Long Markdown context
Select one or more large `.md` notes in Brain → Insert. Confirm all content is present, insertion is materially faster, and there are no giant paragraph gaps. Then synchronize that prepared draft with Multi-Provider.

## 4. Attachments
- **Attach selected .md** should queue selected Markdown files on targets.
- Manually attach a small file in the source composer, enable **Transfer current attachments**, then sync. This works only while the provider still exposes the browser File object; CAIRN reports when it cannot.
- **Detach all .md** / **Detach all from…** should remove all CAIRN-managed attachments without touching vault files.
