import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import cairn.config as config


class EventTicketTests(unittest.TestCase):
    """Unit tests for Runtime's short-lived SSE ticket store.

    /events is used by an EventSource, which cannot send a custom Authorization-style
    header, so it can no longer be handed the long-lived Bridge token directly in the
    URL. Instead callers mint a short-lived, single-purpose ticket over the normal
    authenticated API and use that in the /events query string.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # Runtime() reads/writes config + db under config.data_dir(); redirect that
        # to a scratch directory for the duration of this test so it never touches
        # a real ~/.cairn.
        self._patch = mock.patch.object(config, 'data_dir', return_value=Path(self.tmp.name))
        self._patch.start()
        from cairn.server import Runtime
        self.rt = Runtime()

    def tearDown(self):
        self.rt.db.close()
        self._patch.stop()
        self.tmp.cleanup()

    def test_minted_ticket_is_consumable(self):
        ticket = self.rt.mint_event_ticket(ttl=5.0)
        self.assertTrue(self.rt.consume_event_ticket(ticket))

    def test_unknown_ticket_is_rejected(self):
        self.assertFalse(self.rt.consume_event_ticket('not-a-real-ticket'))

    def test_expired_ticket_is_rejected(self):
        ticket = self.rt.mint_event_ticket(ttl=0.01)
        time.sleep(0.05)
        self.assertFalse(self.rt.consume_event_ticket(ticket))

    def test_ticket_store_does_not_grow_unbounded(self):
        for _ in range(50):
            self.rt.mint_event_ticket(ttl=0.01)
        time.sleep(0.05)
        # The next mint call opportunistically prunes anything already expired.
        self.rt.mint_event_ticket(ttl=5.0)
        self.assertLessEqual(len(self.rt.event_tickets), 2)

    def test_tickets_are_not_guessable_repeats(self):
        a = self.rt.mint_event_ticket(ttl=5.0)
        b = self.rt.mint_event_ticket(ttl=5.0)
        self.assertNotEqual(a, b)


if __name__ == '__main__':
    unittest.main()
