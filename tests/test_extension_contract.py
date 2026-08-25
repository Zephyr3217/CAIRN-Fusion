import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ExtensionContractTests(unittest.TestCase):
    def setUp(self):
        self.content = (ROOT / 'browser_extension' / 'content.js').read_text(encoding='utf-8')
        self.background = (ROOT / 'browser_extension' / 'background.js').read_text(encoding='utf-8')
        self.css = (ROOT / 'browser_extension' / 'content.css').read_text(encoding='utf-8')

    def test_extension_version_and_no_broad_tabs_permission(self):
        manifest = json.loads((ROOT / 'browser_extension' / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'], '0.6.6.7')
        self.assertNotIn('tabs', manifest.get('permissions', []))

    def test_multi_provider_remains_integrated_in_cairn_tabs(self):
        self.assertIn("['multi','Multi-Provider']", self.content)
        self.assertNotIn("multiButton.id = 'cairn-multi-button'", self.content)
        self.assertIn("else if(active==='multi')await renderProviderBroadcastBox(content)", self.content)

    def test_multi_provider_is_source_composer_truth_without_toggles(self):
        start = self.content.index('async function renderProviderBroadcastBox')
        end = self.content.index('async function renderBrainContent', start)
        multi = self.content[start:end]
        for token in ('Insert / Sync', 'Sync & Send All', 'Clear Targets', 'Source composer = truth', 'waitForTransferableSourceFiles'):
            self.assertIn(token, multi)
        self.assertNotIn('Transfer current attachments', multi)
        self.assertNotIn('Include selected Brain context', multi)
        self.assertNotIn('Attach selected .md', multi)
        self.assertIn("attach:false", multi)

    def test_attachment_only_and_two_phase_send_are_present(self):
        multi = self.content[self.content.index('async function renderProviderBroadcastBox'):self.content.index('async function renderBrainContent')]
        self.assertIn("if(!text&&!transfer.files.length)", multi)
        self.assertIn("type:'CAIRN_BROADCAST_SEND'", self.content)
        self.assertIn("send:false", self.content)
        self.assertIn('All targets are ready. Sending source and target AI chats', self.content)
        for token in ('CAIRN_BROADCAST_SEND', 'CAIRN_UI_REMOTE_SEND'):
            self.assertIn(token, self.background + self.content)

    def test_attachment_capture_supports_generic_hidden_filename_state(self):
        for token in ("document.addEventListener('drop'", "document.addEventListener('paste'", 'sourceAttachmentSeenAt', 'visibleAttachmentCount', 'Filename-free provider UI'):
            self.assertIn(token, self.content)
        self.assertIn('tiff?', self.content)
        self.assertIn('ipynb', self.content)
        self.assertIn('application/octet-stream', self.content)

    def test_auto_sync_waits_for_attachment_readiness_before_failing(self):
        self.assertIn('waitForTransferableSourceFiles', self.content)
        self.assertIn('timeoutMs:12000', self.content)
        self.assertIn('Waiting for ${missing.length} attachment', self.content)
        self.assertIn('CAIRN waited for the attachment upload', self.content)
        self.assertIn('Nothing was synchronized or sent', self.content)

    def test_clear_targets_uses_stronger_clear_and_detach(self):
        for token in ('CAIRN_BROADCAST_CLEAR', 'CAIRN_UI_REMOTE_CLEAR', 'clearChatTextRobust'):
            self.assertIn(token, self.background + self.content)
        start = self.content.index("if(msg?.type==='CAIRN_UI_REMOTE_CLEAR')")
        end = self.content.index("if(msg?.type==='CAIRN_UI_REMOTE_SEND')", start)
        clear = self.content[start:end]
        self.assertIn('detachAllComposerAttachments()', clear)
        self.assertIn('clearChatTextRobust()', clear)

    def test_save_chat_has_complete_latest_smart_and_back_navigation(self):
        for token in ('Save Complete Chat', 'Save Latest Chat', 'Smart Save Latest Chat', 'captureSmartLatestReply', 'CAIRN_CAPTURE_PROVIDER_CHATS'):
            self.assertIn(token, self.content + self.background)
        self.assertIn("shell('Save Chat',{back:true", self.content)
        self.assertIn('renderHome(()=>renderChatCapture())', self.content)

    def test_smart_latest_has_provider_specific_last_reply_selectors(self):
        self.assertIn('function smartLatestReplyUnit', self.content)
        self.assertIn("'[data-message-author-role=\"assistant\"]'", self.content)
        self.assertIn("'model-response'", self.content)
        self.assertIn("'[data-testid=\"assistant-message\"]'", self.content)
        self.assertIn("msg.mode==='smart'?captureSmartLatestReply()", self.content)

    def test_reply_notice_is_centered_translucent_red_white_and_readable(self):
        for token in ('CAIRN_PROVIDER_REPLY_DONE', 'CAIRN_UI_PROVIDER_REPLY_DONE', 'has replied', 'beginReplyWatch'):
            self.assertIn(token, self.content + self.background)
        self.assertIn('justify-content:center', self.css)
        self.assertIn('background:rgba(185,28,28,.88)', self.css)
        self.assertIn('color:#fff', self.css)
        self.assertIn('font:800 18px', self.css)
        self.assertIn('3600', self.content)
        self.assertIn('backdrop-filter:blur(8px)', self.css)

    def test_reply_notice_uses_storage_event_bus_and_deduplication(self):
        for token in ('cairnReplyEvent', 'eventId', 'lastReplyToastEventId'):
            self.assertIn(token, self.content + self.background)
        self.assertIn('chrome.storage.local.set({ cairnReplyEvent: event })', self.background)
        self.assertIn('changes.cairnReplyEvent?.newValue', self.content)
        self.assertIn("providerInfo().provider!=='unknown'", self.content)
        self.assertIn('now-stableSince>800', self.content)
        self.assertIn('setTimeout(tick,300)', self.content)

    def test_remote_multi_provider_replaces_instead_of_appending(self):
        start = self.content.index("if(msg?.type==='CAIRN_UI_REMOTE_COMPOSE')")
        end = self.content.index("if(msg?.type==='CAIRN_UI_REMOTE_DETACH')", start)
        remote = self.content[start:end]
        self.assertIn('replaceChatTextRobust(msg.text)', remote)
        self.assertNotIn('insertIntoChatRobust(msg.text)', remote)

    def test_send_button_is_provider_specific_and_excludes_incognito_controls(self):
        start = self.content.index('function findSendButton')
        end = self.content.index('async function copyFallback', start)
        send = self.content[start:end]
        self.assertIn("provider==='claude'", send)
        self.assertIn('incognito|temporary|private|mode', send)
        self.assertNotIn("'button[type=\"submit\"]'", send.split('const selectors=', 1)[1].split('const candidates=', 1)[0])
        self.assertIn("providerInfo().provider!=='claude'", send)

    def test_large_note_limit_is_30000_and_recommends_attachment(self):
        self.assertIn('INLINE_TEXT_ATTACHMENT_LIMIT = 30000', self.content)
        self.assertIn('Large text note detected', self.content)
        self.assertIn('Nothing was inserted or sent', self.content)
        self.assertIn('attach the .md file itself', self.content)
        self.assertIn('inlineAttachmentWarning(bundle)', self.content)

    def test_brain_sorting_and_note_metrics_exist(self):
        for token in ('Name A → Z', 'Name Z → A', 'Most text → least', 'Least text → most', 'cairn-note-size', 'chars ·'):
            self.assertIn(token, self.content + self.css)
        self.assertIn('noteChars(b)-noteChars(a)', self.content)
        self.assertIn('noteChars(a)-noteChars(b)', self.content)

    def test_brain_attachment_selection_resets_after_success(self):
        self.assertIn('Brain selection reset to 0', self.content)
        self.assertIn('brainSelected.clear();drawNotes();updateSelected()', self.content)

    def test_per_tab_tutorials_exist(self):
        for token in ('How to use Brain', 'How to use Multi-Provider', 'How to use Agent', 'How to use Save Chat', 'showTabTutorial'):
            self.assertIn(token, self.content)
        self.assertIn('cairn-tab-tutorial-overlay', self.css)

    def test_long_context_fast_path_preserves_line_breaks(self):
        self.assertIn('replaceEditableFast', self.content)
        self.assertIn('DocumentFragment', self.content)
        self.assertIn("document.createElement('br')", self.content)
        self.assertNotIn("for(const line of lines){const p=document.createElement('p')", self.content)

    def test_context_metadata_exposes_word_count_for_warning(self):
        context_py = (ROOT / 'cairn' / 'context.py').read_text(encoding='utf-8')
        server_py = (ROOT / 'cairn' / 'server.py').read_text(encoding='utf-8')
        db_py = (ROOT / 'cairn' / 'db.py').read_text(encoding='utf-8')
        self.assertIn('words: int', context_py)
        self.assertIn('"words": n.words', context_py)
        self.assertIn('char_count AS chars', server_py)
        self.assertIn('word_count AS words', server_py)
        self.assertIn('ALTER TABLE notes ADD COLUMN char_count', db_py)
        self.assertIn('ALTER TABLE notes ADD COLUMN word_count', db_py)

    def test_idle_launcher_is_compact_and_expands_on_hover(self):
        self.assertIn("launcherDock.id = 'cairn-launcher-dock'", self.content)
        self.assertIn("assistantButton.dataset.short = 'C'", self.content)
        self.assertIn("chatButton.dataset.short = 'S'", self.content)
        self.assertIn('#cairn-launcher-dock:hover', self.css)
        self.assertIn('#cairn-launcher-dock.is-active', self.css)

    def test_current_attachment_list_is_realtime_and_has_per_file_remove(self):
        for token in ('cairn-current-attachment-list', 'cairn-current-attachment-item', 'cairn-attachment-remove', 'detachOneComposerAttachment'):
            self.assertIn(token, self.content + self.css)
        self.assertIn("currentList.replaceChildren()", self.content)
        self.assertIn("setInterval(()=>{if(!box.isConnected)", self.content)

    def test_typed_filenames_are_not_treated_as_attachment_chips(self):
        start = self.content.index('function visibleAttachmentNames')
        end = self.content.index('function normalizeAttachmentName', start)
        block = self.content[start:end]
        self.assertIn('const composer=findChatInput()', block)
        self.assertIn('composer.contains?.(el)', block)
        self.assertIn('el.contains?.(composer)', block)

    def test_provider_refresh_reloads_targets_but_excludes_source(self):
        self.assertIn('CAIRN_REFRESH_PROVIDER_TABS', self.content + self.background)
        self.assertIn('tab.tabId !== sourceTabId', self.background)
        self.assertIn('chrome.tabs.reload(tab.tabId)', self.background)
        self.assertIn("refreshTargets({reloadPages:true})", self.content)

    def test_reply_notice_is_mirrored_to_same_window_provider_tabs(self):
        start = self.background.index('async function broadcastReplyNotice')
        end = self.background.index('async function handleMessage', start)
        block = self.background[start:end]
        self.assertIn('sender?.tab?.windowId', block)
        self.assertIn("CAIRN_UI_PROVIDER_REPLY_DONE", block)
        self.assertIn('Promise.all(targets.map', block)

    def test_save_chat_inbox_names_are_deterministic(self):
        for token in ('NEIL-COMPLETE CHAT', 'NEIL-LATEST CHAT', 'NEIL-SMART CHAT', 'captureInboxTitle'):
            self.assertIn(token, self.content)
        self.assertIn('title:captureInboxTitle||captureTitle||document.title', self.content)

    def test_target_attachment_upload_waits_for_provider_ui_before_ready(self):
        for token in ('waitForComposerAttachmentUi', 'ATTACHMENT_LOAD_TIMEOUT', 'visibleAttachmentCount()>=expected.size'):
            self.assertIn(token, self.content)
        start = self.content.index('async function attachTransferredFiles')
        end = self.content.index('function attachmentNames', start)
        block = self.content[start:end]
        self.assertIn('await waitForComposerAttachmentUi', block)
        self.assertIn('ready:true', block)


if __name__ == '__main__':
    unittest.main()
