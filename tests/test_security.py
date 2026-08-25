import os
import tempfile
import unittest
from pathlib import Path

from cairn.security import safe_resolve, SecurityError, CapabilityManager
from cairn.db import Database


class TraversalTests(unittest.TestCase):
    """Regression tests for safe_resolve's path-traversal boundary.

    These pin down the current, correct behavior so a future change can't silently
    reopen the boundary. Backslash-based payloads are inert on POSIX (backslash is
    just a filename character there) but are real separators on the project's actual
    Windows deployment target, so both forms are covered even though only the
    forward-slash form is exploitable on the Linux box these tests run on.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / 'vault'
        self.root.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def test_parent_traversal_rejected(self):
        with self.assertRaises(SecurityError):
            safe_resolve(self.root, '../outside.md')

    def test_deep_parent_traversal_rejected(self):
        with self.assertRaises(SecurityError):
            safe_resolve(self.root, '../../../../etc/passwd')

    def test_absolute_path_rejected(self):
        # pathlib's `/` operator discards the left side entirely when the right
        # side is absolute, so this must be caught by the is_relative_to() check
        # after resolve(), not by string-prefix inspection of the input.
        with self.assertRaises(SecurityError):
            safe_resolve(self.root, '/etc/passwd')

    def test_normal_relative_path_is_allowed(self):
        p = safe_resolve(self.root, 'Notes/Chapter 1.md')
        self.assertTrue(str(p).startswith(str(self.root)))

    def test_traversal_that_lands_back_inside_root_is_allowed(self):
        # "../vault/Notes/x.md" from inside root resolves back under root and
        # should NOT be rejected just because it contains "..".
        (self.root / 'Notes').mkdir()
        p = safe_resolve(self.root, '../vault/Notes/x.md')
        self.assertTrue(str(p).startswith(str(self.root)))

    def test_symlink_escape_is_rejected(self):
        outside = Path(self.tmp.name) / 'outside.md'
        outside.write_text('secret', encoding='utf-8')
        link = self.root / 'link.md'
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest('symlinks not supported in this environment')
        with self.assertRaises(SecurityError):
            safe_resolve(self.root, 'link.md')


class CapabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tmp.name) / 'test.db')
        self.caps = CapabilityManager(self.db)

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_unknown_client_has_no_access(self):
        self.assertFalse(self.caps.allowed('someone-else', 'write', 'Inbox/x.md'))

    def test_default_browser_grant_covers_vault(self):
        self.caps.ensure_default()
        self.assertTrue(self.caps.allowed('browser-extension', 'write', 'Anything/x.md'))
        self.assertTrue(self.caps.allowed('browser-extension', 'read', 'Anything/x.md'))

    def test_scoped_grant_denies_paths_outside_its_scope(self):
        import json, time
        self.db.execute(
            "INSERT INTO grants(grant_id,client_id,read_scopes,write_scopes,created_at) VALUES(?,?,?,?,?)",
            ("scoped", "limited-client", json.dumps(["**"]), json.dumps(["Inbox/**"]), int(time.time())),
        )
        self.assertTrue(self.caps.allowed('limited-client', 'write', 'Inbox/Capture.md'))
        self.assertFalse(self.caps.allowed('limited-client', 'write', 'Thesis/Chapter 1.md'))


if __name__ == '__main__':
    unittest.main()
