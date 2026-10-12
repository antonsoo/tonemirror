"""Check paired actual-browser results and summarize desktop timing medians.

python3 compare-browser.py BEFORE/browser.json AFTER/browser.json OUTPUT.json
"""
import json
import statistics
import sys
from pathlib import Path

before, after = [json.loads(Path(p).read_text()) for p in sys.argv[1:3]]
key = lambda row: tuple(row[k] for k in ("engine", "width", "fixture", "algorithm", "iteration"))
a, b = [{key(row): row for row in report["rows"]} for report in (before, after)]
assert len(a) == len(b) == 32 and a.keys() == b.keys()
fields = ("browser", "sampleRate", "samples", "frames", "voiced", "pcmSha256", "contourRoundedSha256", "spectrumSha256")
for identity in a:
    for field in fields:
        assert a[identity][field] == b[identity][field], (identity, field)
for report in (before, after):
    assert len(report["captures"]) == 4
    for row in report["captures"]:
        assert row["scores"] == {"yin": "100", "mpm": "100"}
        assert row["overflow"] == 0
        assert not row["errors"] and not row["requestsAfterServerStopped"] and not row["policyViolations"]
summaries = []
for engine in ("chromium", "firefox"):
    for fixture in ("phrase", "repeated60"):
        for algorithm in ("yin", "mpm"):
            row = {"engine": engine, "fixture": fixture, "algorithm": algorithm, "runsPerRevision": 3}
            for metric in ("workerMs", "uploadToReadyMs"):
                medians = [statistics.median(r[metric] for r in report["rows"] if r["engine"] == engine and r["width"] == 1440 and r["fixture"] == fixture and r["algorithm"] == algorithm) for report in (before, after)]
                row[metric] = {"before": medians[0], "after": medians[1], "speedup": medians[0] / medians[1]}
            summaries.append(row)
result = {"pairedUploads": len(a), "equalFields": fields, "selfComparisonScores": "100 for both algorithms in all eight captures", "desktopMedians": summaries}
Path(sys.argv[3]).write_text(json.dumps(result, indent=2) + "\n")
print(json.dumps(result, indent=2))
