"""Fetch the PTDB-TUG subset and the CSTR FDA evaluation database into ./cache and
write manifest.json (URL, size, sha256 per file).

PTDB-TUG is served as plain files, so a balanced subset is fetched per file:
every speaker, sentences sa1 and sa2 plus 22 sentences taken at even spacing from
the speaker's sorted list of sx/si sentences. Only microphone wav and reference
.f0 files are fetched (the laryngograph wav is not needed; the reference F0 was
computed from it by the corpus authors).

Run: python3 -I fetch.py
"""
import hashlib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / "cache"
UA = "tonemirror-study/0.1 (research; anton@praviel.com)"
PTDB = "http://www2.spsc.tugraz.at/databases/PTDB-TUG"
FDA_URL = "https://www.cstr.ed.ac.uk/research/projects/fda/fda_eval.tar.gz"
N_EXTRA = 22


def get(url: str, retries: int = 4) -> bytes:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


def listing(url: str) -> list[str]:
    html = get(url).decode("utf-8", "replace")
    return [urllib.parse.unquote(h) for h in re.findall(r'href="([^"?/][^"?]*)"', html)]


def pick(names: list[str]) -> list[str]:
    """names: sorted sentence ids like sa1, si453. Keep sa1, sa2 and N_EXTRA evenly spaced others."""
    rest = sorted(n for n in names if not n.startswith("sa"))
    step = len(rest) / N_EXTRA
    chosen = [rest[int(i * step)] for i in range(N_EXTRA)]
    return ["sa1", "sa2"] + chosen


def main() -> None:
    CACHE.mkdir(exist_ok=True)
    jobs: list[tuple[str, Path]] = []
    for sex_dir, sex in (("FEMALE", "F"), ("MALE", "M")):
        for n in range(1, 11):
            spk = f"{sex}{n:02d}"
            base = f"{PTDB}/SPEECH%20DATA/{sex_dir}"
            ids = [re.match(rf"ref_{spk}_(.+)\.f0$", f).group(1)
                   for f in listing(f"{base}/REF/{spk}/") if re.match(rf"ref_{spk}_(.+)\.f0$", f)]
            for sid in pick(ids):
                jobs.append((f"{base}/REF/{spk}/ref_{spk}_{sid}.f0", CACHE / "ptdb" / spk / f"ref_{spk}_{sid}.f0"))
                jobs.append((f"{base}/MIC/{spk}/mic_{spk}_{sid}.wav", CACHE / "ptdb" / spk / f"mic_{spk}_{sid}.wav"))
    for doc in ("SPEAKER-PROFILES.txt", "RECORDING-PROTOCOL.txt"):
        jobs.append((f"{PTDB}/DOCUMENTATION/{doc}", CACHE / "ptdb" / "DOCUMENTATION" / doc))
    jobs.append((FDA_URL, CACHE / "fda" / "fda_eval.tar.gz"))

    def fetch(job: tuple[str, Path]) -> dict:
        url, path = job
        if not path.exists():
            path.parent.mkdir(parents=True, exist_ok=True)
            data = get(url)
            path.write_bytes(data)
        data = path.read_bytes()
        return {"url": url, "path": str(path.relative_to(CACHE)), "bytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}

    with ThreadPoolExecutor(max_workers=4) as ex:
        files = list(ex.map(fetch, jobs))
    manifest = {
        "fetched": time.strftime("%Y-%m-%d", time.gmtime()),
        "sources": {
            "PTDB-TUG": {"index": PTDB + "/", "licence": "ODbL 1.0 (database), DbCL 1.0 (contents); "
                         "https://www.spsc.tugraz.at/databases-and-tools/ptdb-tug-pitch-tracking-database-from-graz-university-of-technology.html"},
            "FDA": {"index": "https://www.cstr.ed.ac.uk/research/projects/fda/",
                    "licence": "none stated on the project page; site footer: all material copyright University of Edinburgh unless stated"},
        },
        "files": files,
    }
    (HERE / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(len(files), "files,", sum(f["bytes"] for f in files) // 1_000_000, "MB", file=sys.stderr)


if __name__ == "__main__":
    main()
