"""CLI tests against an in-memory homeserver (tests/mockhs.py).

  cd cli && python -m unittest discover -s tests
"""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from mockhs import ALIAS, USER, MockHS

from mxwiki import wiki
from mxwiki.client import load_creds

VECTORS = json.loads((Path(__file__).resolve().parents[2] / "spec" / "vectors.json").read_text())


class CliCase(unittest.TestCase):
    def setUp(self):
        self.hs = MockHS()
        self.addCleanup(self.hs.close)
        env = {k: v for k, v in os.environ.items() if k not in ("MATRIX_HOMESERVER", "MATRIX_ACCESS_TOKEN", "WIKI_ROOM", "MXWIKI_WIDGET_URL")}
        patcher = unittest.mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_cli(self, *argv, stdin=""):
        """Returns (exit message or None, stdout)."""
        out = io.StringIO()
        with contextlib.redirect_stdout(out), unittest.mock.patch("sys.stdin", io.StringIO(stdin)):
            try:
                wiki.main(["--hs", self.hs.url, "--token", "tok", "--room", ALIAS, *argv])
            except SystemExit as e:
                return str(e.code), out.getvalue()
        return None, out.getvalue()


class TestSpecConstants(unittest.TestCase):
    def test_constants_match_vectors(self):
        self.assertEqual(wiki.PAGE_TYPE, VECTORS["page_type"])
        self.assertEqual(wiki.WIDGET_ID, VECTORS["widget_state_key"])
        self.assertEqual(wiki.MAX_BODY, VECTORS["max_body_bytes"])


class TestSlug(CliCase):
    def test_vectors(self):
        for s in VECTORS["slug_valid"]:
            self.assertTrue(wiki.valid_slug(s), s)
        for s in VECTORS["slug_invalid"]:
            self.assertFalse(wiki.valid_slug(s), s)

    def test_put_rejects_bad_slug_without_writing(self):
        err, _ = self.run_cli("put", "Bad Slug", stdin="# x\n")
        self.assertIn("bad slug", err)
        self.assertEqual(self.hs.writes(), [])


class TestBodyLimit(CliCase):
    def test_at_limit_is_written(self):
        body = "x" * VECTORS["max_body_bytes"]
        err, _ = self.run_cli("put", "big", "--title", "Big", stdin=body)
        self.assertIsNone(err)
        c = self.hs.state[(wiki.PAGE_TYPE, "big")]["content"]
        self.assertEqual(c["body"], body)
        self.assertEqual(c["title"], "Big")
        self.assertEqual(c["updated_by"], USER)
        self.assertRegex(c["updated_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_over_limit_is_refused(self):
        err, _ = self.run_cli("put", "big", stdin="x" * (VECTORS["max_body_bytes"] + 1))
        self.assertIn("limit", err)
        self.assertEqual(self.hs.writes(), [])

    def test_limit_counts_utf8_bytes(self):
        err, _ = self.run_cli("put", "jp", stdin="あ" * (VECTORS["max_body_bytes"] // 3 + 1))
        self.assertIn("limit", err)
        self.assertEqual(self.hs.writes(), [])

    def test_title_from_heading(self):
        self.run_cli("put", "notes/a", stdin="# Hello\n\nbody\n")
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "notes/a")]["content"]["title"], "Hello")


class TestMigrate(CliCase):
    OLD = "org.example.wiki.page"

    def seed(self):
        self.hs.add_state(self.OLD, "home", {"title": "Home", "body": "# Home\n", "updated_by": "@bob:example.org", "updated_at": "2026-01-02T03:04:05Z"})
        self.hs.add_state(self.OLD, "gone", {})                 # deleted: ignored
        self.hs.add_state(self.OLD, "Bad Slug", {"title": "x", "body": "x"})
        self.hs.add_state(wiki.PAGE_TYPE, "exists", {"title": "New", "body": "new"})
        self.hs.add_state(self.OLD, "exists", {"title": "Old", "body": "old"})

    def test_dry_run_writes_nothing(self):
        self.seed()
        err, out = self.run_cli("migrate", "--from", self.OLD, "--dry-run")
        self.assertIsNone(err)
        self.assertEqual(self.hs.writes(), [])
        self.assertIn("would put home", out)
        self.assertIn("skip 'Bad Slug'", out)
        self.assertIn("skip exists", out)
        self.assertIn("would migrate 1 page(s)", out)

    def test_migrate_copies_and_keeps_old(self):
        self.seed()
        err, _ = self.run_cli("migrate", "--from", self.OLD)
        self.assertIsNone(err)
        c = self.hs.state[(wiki.PAGE_TYPE, "home")]["content"]
        self.assertEqual(c, {"title": "Home", "body": "# Home\n", "updated_by": "@bob:example.org", "updated_at": "2026-01-02T03:04:05Z"})
        self.assertEqual(self.hs.state[(self.OLD, "home")]["content"]["body"], "# Home\n")  # old type untouched
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "exists")]["content"]["body"], "new")  # not overwritten
        self.assertEqual([w[1].rsplit("/", 2)[-2:] for w in self.hs.writes()], [[wiki.PAGE_TYPE, "home"]])

    def test_force_overwrites(self):
        self.seed()
        self.run_cli("migrate", "--from", self.OLD, "--force")
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "exists")]["content"]["body"], "old")

    def test_timeline_pointer(self):
        # MyWiki PoC shape: body in a (possibly edited) m.room.message, state points at the latest version.
        first = self.hs.add_event("m.room.message", {"msgtype": "m.text", "body": "[wiki:a] A\n\nv1", "wiki.raw": "v1"})
        edit = self.hs.add_event("m.room.message", {"msgtype": "m.text", "body": "* [wiki:a] A\n\nv2",
                                                     "m.new_content": {"msgtype": "m.text", "body": "[wiki:a] A\n\nv2", "wiki.raw": "v2"},
                                                     "m.relates_to": {"rel_type": "m.replace", "event_id": first["event_id"]}})
        self.hs.add_state("com.example.wiki.page_a", "a", {"title": "A", "latest_event_id": edit["event_id"]})
        # Profile T shape with a body hash that must match.
        body_t = self.hs.add_event("com.knatrix.mxwiki.body", {"slug": "t", "title": "T", "body": "tee"})
        self.hs.add_state("com.example.wiki.page_a", "t", {"title": "T", "root_event_id": body_t["event_id"], "latest_event_id": body_t["event_id"],
                                                           "body_sha256": hashlib.sha256(b"tee").hexdigest()})
        bad = self.hs.add_event("com.knatrix.mxwiki.body", {"slug": "u", "title": "U", "body": "tampered"})
        self.hs.add_state("com.example.wiki.page_a", "u", {"title": "U", "latest_event_id": bad["event_id"], "body_sha256": "0" * 64})
        err, out = self.run_cli("migrate", "--from", "com.example.wiki.page_a")
        self.assertIsNone(err, out)
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "a")]["content"]["body"], "v2")
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "t")]["content"]["body"], "tee")
        self.assertNotIn((wiki.PAGE_TYPE, "u"), self.hs.state)
        self.assertIn("body_sha256", out)


class TestPinAndGrant(CliCase):
    def test_pin_requires_url(self):
        err, _ = self.run_cli("pin")
        self.assertIn("--url", err)
        self.assertEqual(self.hs.writes(), [])

    def test_pin_appends_template(self):
        self.run_cli("pin", "--url", "https://wiki.example.org/")
        c = self.hs.state[("im.vector.modular.widgets", VECTORS["widget_state_key"])]["content"]
        self.assertEqual(c["url"], "https://wiki.example.org/?roomId=$matrix_room_id&widgetId=$matrix_widget_id&userId=$matrix_user_id")
        self.assertEqual((c["type"], c["name"], c["creatorUserId"]), ("m.custom", "Wiki", USER))

    def test_pin_url_from_env(self):
        os.environ["MXWIKI_WIDGET_URL"] = "https://w.example.org/?roomId=$matrix_room_id&widgetId=$matrix_widget_id"
        self.run_cli("pin")
        c = self.hs.state[("im.vector.modular.widgets", VECTORS["widget_state_key"])]["content"]
        self.assertEqual(c["url"], os.environ["MXWIKI_WIDGET_URL"])

    def test_grant_edit(self):
        self.hs.add_state("m.room.power_levels", "", {"users": {USER: 100}, "state_default": 50, "events": {"m.room.power_levels": 100}})
        err, _ = self.run_cli("grant-edit")
        self.assertIsNone(err)
        self.assertEqual(self.hs.state[("m.room.power_levels", "")]["content"]["events"][wiki.PAGE_TYPE], 0)

    def test_grant_edit_needs_admin(self):
        self.hs.add_state("m.room.power_levels", "", {"users": {USER: 50}, "state_default": 50, "events": {"m.room.power_levels": 100}})
        err, _ = self.run_cli("grant-edit", "--level", "0")
        self.assertIn("100", err)
        self.assertEqual(self.hs.writes(), [])


class TestCreds(unittest.TestCase):
    def args(self, **kw):
        return type("A", (), {"hs": None, "token": None, "env_file": None, **kw})()

    def test_precedence(self):
        with tempfile.NamedTemporaryFile("w", suffix=".env", delete=False) as f:
            f.write('# bot\nexport MATRIX_HOMESERVER="https://file.example.org"\nMATRIX_ACCESS_TOKEN=\'file-tok\'\nOTHER=x\n')
        self.addCleanup(os.unlink, f.name)
        env = {"MATRIX_HOMESERVER": "https://env.example.org", "MATRIX_ACCESS_TOKEN": "env-tok"}
        with unittest.mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(load_creds(self.args()), ("https://env.example.org", "env-tok"))
            self.assertEqual(load_creds(self.args(env_file=f.name)), ("https://file.example.org", "file-tok"))
            self.assertEqual(load_creds(self.args(env_file=f.name, token="arg-tok")), ("https://file.example.org", "arg-tok"))
            self.assertEqual(load_creds(self.args(env_file=f.name, hs="https://arg.example.org", token="arg-tok")), ("https://arg.example.org", "arg-tok"))

    def test_missing(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as cm:
                load_creds(self.args(hs="https://x.example.org"))
            self.assertIn("MATRIX_ACCESS_TOKEN", str(cm.exception.code))


class TestRoundTrip(CliCase):
    def test_put_get_mv_rm(self):
        self.run_cli("put", "a", stdin="# A\n\nhello [[b]]\n")
        _, out = self.run_cli("get", "a")
        self.assertEqual(out, "# A\n\nhello [[b]]\n")
        self.run_cli("mv", "a", "b/c")
        self.assertEqual(self.hs.state[(wiki.PAGE_TYPE, "a")]["content"], {})
        err, _ = self.run_cli("get", "a")
        self.assertIn("no such page", err)
        _, out = self.run_cli("list")
        self.assertIn("b/c", out)
        self.run_cli("rm", "b/c")
        _, out = self.run_cli("list")
        self.assertEqual(out, "")


if __name__ == "__main__":
    unittest.main()
