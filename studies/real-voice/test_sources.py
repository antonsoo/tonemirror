"""Offline source-integrity controls: python3 -I studies/real-voice/test_sources.py."""

import hashlib
import importlib.util
import io
import json
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "study_fetch", Path(__file__).with_name("fetch.py")
)
fetch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fetch)


def record(path, data):
    return {
        "path": path,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "url": "https://example.invalid/fixture",
    }


class SourceIntegrity(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.cache = self.root / "cache"
        self.source = record("ptdb/F01/ref_F01_sa1.f0", b"100 1 0.1 1\n")

    def test_changed_cached_source_is_refused(self):
        path = self.cache / self.source["path"]
        fetch.save(path, b"altered")
        with (
            patch.object(
                fetch.urllib.request, "urlopen", side_effect=AssertionError("network")
            ),
            self.assertRaisesRegex(ValueError, "pinned size/hash"),
        ):
            fetch.fetch_sources(self.cache, [self.source], False)
        self.assertEqual(path.read_bytes(), b"altered")

    def test_incomplete_download_never_becomes_a_cached_source(self):
        with (
            patch.object(
                fetch.urllib.request, "urlopen", return_value=io.BytesIO(b"partial")
            ),
            self.assertRaisesRegex(ValueError, "pinned size/hash"),
        ):
            fetch.fetch_sources(self.cache, [self.source], False)
        self.assertFalse((self.cache / self.source["path"]).exists())

    def test_verified_download_is_reusable_without_network(self):
        with patch.object(
            fetch.urllib.request, "urlopen", return_value=io.BytesIO(b"100 1 0.1 1\n")
        ):
            fetch.fetch_sources(self.cache, [self.source], False)
        with patch.object(
            fetch.urllib.request, "urlopen", side_effect=AssertionError("network")
        ):
            fetch.fetch_sources(self.cache, [self.source], True)

    def test_missing_offline_source_is_refused(self):
        with self.assertRaisesRegex(ValueError, "Missing pinned source"):
            fetch.fetch_sources(self.cache, [self.source], True)

    def archive(self):
        path = self.cache / "fda/fda_eval.tar.gz"
        path.parent.mkdir(parents=True)
        with tarfile.open(path, "w:gz") as archive:
            for speaker in ["rl", "sb"]:
                for index in range(1, 51):
                    for suffix in ["fx", "sig"]:
                        name = f"{speaker}/{speaker}{index:03}.{suffix}"
                        data = b"synthetic reference or waveform"
                        member = tarfile.TarInfo(name)
                        member.size = len(data)
                        archive.addfile(member, io.BytesIO(data))
            # Unrelated archive paths and executable files are never extracted.
            for name in ["../outside", "src/program"]:
                member = tarfile.TarInfo(name)
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
        return record("fda/fda_eval.tar.gz", path.read_bytes())

    def test_fda_preparation_and_manifest_are_repeatable(self):
        source = self.archive()
        manifest = json.dumps({"files": [source]})
        (self.root / "manifest.json").write_text(manifest)
        with (
            patch.object(fetch, "HERE", self.root),
            patch.object(
                sys, "argv", ["fetch.py", "--offline", "--cache", str(self.cache)]
            ),
        ):
            fetch.main()
            fetch.main()
        self.assertEqual(len(list((self.cache / "fda-extracted").rglob("*.sig"))), 100)
        self.assertEqual((self.root / "manifest.json").read_text(), manifest)
        self.assertFalse((self.cache / "fda-extracted/src").exists())
        self.assertFalse((self.cache / "outside").exists())

    def test_changed_extracted_fda_is_refused_without_repairing_it(self):
        self.archive()
        fetch.prepare_fda(self.cache)
        path = self.cache / "fda-extracted/rl/rl001.sig"
        path.write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "differs from pinned archive"):
            fetch.prepare_fda(self.cache)
        self.assertEqual(path.read_bytes(), b"changed")

    def test_extra_recordings_cannot_silently_expand_the_corpus(self):
        fetch.save(self.cache / "ptdb/F01/mic_F01_extra.wav", b"extra")
        with self.assertRaisesRegex(ValueError, "Unrecorded study input"):
            fetch.reject_extras(self.cache / "ptdb", set(), {".wav", ".f0"})
        self.archive()
        fetch.save(self.cache / "fda-extracted/rl/rl999.sig", b"extra")
        with self.assertRaisesRegex(ValueError, "Unrecorded study input"):
            fetch.prepare_fda(self.cache)


if __name__ == "__main__":
    unittest.main()
