import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class ExtensionContractTests(unittest.TestCase):
    def test_extension_version_and_no_broad_tabs_permission(self):
        manifest = json.loads((ROOT / 'browser_extension' / 'manifest.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['version'], '0.6.6')
        self.assertNotIn('tabs', manifest.get('permissions', []))

    def test_multi_provider_background_contract_is_packaged(self):
        source = (ROOT / 'browser_extension' / 'background.js').read_text(encoding='utf-8')
        for token in ('CAIRN_LIST_PROVIDER_TABS', 'CAIRN_BROADCAST_PROMPT', 'CAIRN_BROADCAST_DETACH', 'CAIRN_PROVIDER_PING'):
            self.assertIn(token, source)

    def test_brain_exposes_broadcast_and_detach_controls(self):
        source = (ROOT / 'browser_extension' / 'content.js').read_text(encoding='utf-8')
        for text in ('Multi-Provider Prompt', 'Insert chat to…', 'Detach .md', 'Detach from…'):
            self.assertIn(text, source)
        for provider in ("provider:'chatgpt'", "provider:'claude'", "provider:'gemini'"):
            self.assertIn(provider, source)

    def test_broadcast_is_insert_only(self):
        source = (ROOT / 'browser_extension' / 'content.js').read_text(encoding='utf-8')
        self.assertIn('CAIRN never presses Send.', source)
        # The remote compose handler should only insert text / attach files; it must not
        # contain an explicit click on a send/submit control.
        start = source.index("if(msg?.type==='CAIRN_UI_REMOTE_COMPOSE')")
        end = source.index("if(msg?.type==='CAIRN_UI_REMOTE_DETACH')", start)
        remote = source[start:end]
        self.assertNotIn('.click()', remote)
        self.assertNotIn('requestSubmit', remote)


if __name__ == '__main__':
    unittest.main()
