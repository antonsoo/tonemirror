"""Fetch the recorded PTDB-TUG subset and prepare FDA from the pinned manifest.

Existing files and downloads must match manifest.json. The manifest is never
rewritten. No network is used when every source is already cached.

Run: python3 -I studies/real-voice/fetch.py [--cache PATH] [--offline]
"""

import argparse
import hashlib
import json
import os
import re
import sys
import tarfile
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path, PurePosixPath

HERE = Path(__file__).resolve().parent
UA = "tonemirror-study/0.1 (research; anton@praviel.com)"


def relative_path(value):
    path = PurePosixPath(value)
    if path.is_absolute() or ".." in path.parts or str(path) != value or not path.parts:
        raise ValueError(f"Invalid source path: {value!r}")
    return Path(*path.parts)


def check(data, record):
    if (
        len(data) != record["bytes"]
        or hashlib.sha256(data).hexdigest() != record["sha256"]
    ):
        raise ValueError(
            f"Source does not match the pinned size/hash: {record['path']}"
        )


def save(path, data):
    """Make a completed file visible only after all its bytes have been written."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        try:
            stream.write(data)
            stream.close()
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def fetch_sources(cache, records, offline):
    # Check every existing source before making any new downloads. A changed
    # file is evidence of a different input, not a new expected hash.
    missing = []
    for record in records:
        path = cache / relative_path(record["path"])
        if path.exists():
            check(path.read_bytes(), record)
        else:
            missing.append(record)
    if offline and missing:
        raise ValueError(f"Missing pinned source in offline mode: {missing[0]['path']}")

    def fetch(record):
        request = urllib.request.Request(record["url"], headers={"User-Agent": UA})
        with urllib.request.urlopen(request, timeout=45) as response:
            data = response.read(record["bytes"] + 1)
        check(data, record)
        save(cache / relative_path(record["path"]), data)

    with ThreadPoolExecutor(max_workers=4) as executor:
        # Consume the iterator so a failed download cannot look like success.
        list(executor.map(fetch, missing))


def prepare_fda(cache):
    """Copy only regular waveform/reference files and the two corpus documents.

    Compare already extracted bytes with the verified archive too. tarfile's
    extract/extractall are deliberately unnecessary: no links, permissions or
    arbitrary archive paths are materialized.
    """
    output = cache / "fda-extracted"
    expected = {}
    with tarfile.open(cache / "fda/fda_eval.tar.gz", "r:gz") as archive:
        for member in archive:
            if not (
                re.fullmatch(r"(rl|sb)/\1\d{3}\.(sig|fx)", member.name)
                or member.name in {"README", "orthographic.index"}
            ):
                continue
            if not member.isfile() or member.name in expected:
                raise ValueError(f"Invalid FDA archive member: {member.name}")
            stream = archive.extractfile(member)
            if stream is None:
                raise ValueError(f"Unreadable FDA archive member: {member.name}")
            with stream:
                data = stream.read()
            expected[member.name] = data
    pairs = {name[:-4] for name in expected if name.endswith(".sig")}
    references = {name[:-3] for name in expected if name.endswith(".fx")}
    if pairs != references or len(pairs) != 100:
        raise ValueError("Pinned FDA archive must contain 100 waveform/reference pairs")
    reject_extras(output, set(expected), {".sig", ".fx"})
    for name, data in expected.items():
        path = output / relative_path(name)
        if path.exists() and path.read_bytes() != data:
            raise ValueError(f"Extracted FDA file differs from pinned archive: {name}")
    for name, data in expected.items():
        path = output / relative_path(name)
        if not path.exists():
            save(path, data)
    return len(pairs)


def reject_extras(root, expected, suffixes):
    for path in root.rglob("*"):
        if (
            path.is_file()
            and path.suffix in suffixes
            and path.relative_to(root).as_posix() not in expected
        ):
            raise ValueError(
                f"Unrecorded study input: {path.relative_to(root).as_posix()}"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=HERE / "cache")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    records = json.loads((HERE / "manifest.json").read_text())["files"]
    names = [row["path"] for row in records]
    if len(names) != len(set(names)) or "fda/fda_eval.tar.gz" not in names:
        raise ValueError("Invalid or incomplete source manifest")
    for row in records:
        relative_path(row["path"])
        if (
            not isinstance(row["bytes"], int)
            or row["bytes"] <= 0
            or not re.fullmatch(r"[0-9a-f]{64}", row["sha256"])
        ):
            raise ValueError(f"Invalid source dimensions/hash: {row['path']}")
    reject_extras(
        args.cache / "ptdb",
        {name[5:] for name in names if name.startswith("ptdb/")},
        {".wav", ".f0"},
    )
    fetch_sources(args.cache, records, args.offline)
    pairs = prepare_fda(args.cache)
    print(
        f"Verified {len(records)} pinned sources ({sum(r['bytes'] for r in records):,} bytes); prepared {pairs} FDA waveform/reference pairs."
    )


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, tarfile.TarError) as error:
        print(f"Study preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
