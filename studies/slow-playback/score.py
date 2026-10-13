"""Independent pitch preservation check, not a listening or ground-truth study.
python -I studies/slow-playback/score.py RENDER_DIRECTORY RESULTS_JSON
Requires numpy==2.3.3, praat-parselmouth==0.4.7, soundfile==0.13.1.
"""
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
import parselmouth
import soundfile as sf

render_dir, result_file = map(Path, sys.argv[1:])
render = json.loads((render_dir / 'render.json').read_text())
cache = Path(__file__).resolve().parents[1] / 'real-voice/cache'
all_cents, all_signed, rows = [], [], []


def pitch(pcm, rate):
    p = parselmouth.Sound(pcm, sampling_frequency=rate).to_pitch_ac(
        time_step=.01, pitch_floor=60, pitch_ceiling=1000)
    return p.xs(), p.selected_array['frequency']


for item in render['speech']:
    original_path = cache / item['path']
    assert hashlib.sha256(original_path.read_bytes()).hexdigest() == item['sourceSha256']
    x, rate = sf.read(original_path, dtype='float32')
    stretched_path = render_dir / (original_path.stem + '.f32')
    assert hashlib.sha256(stretched_path.read_bytes()).hexdigest() == item['outputSha256']
    y = np.fromfile(stretched_path, dtype='<f4')
    assert len(y) == 2 * len(x)
    tx, fx = pitch(x, rate)
    ty, fy = pitch(y, rate)
    # Map output time = twice source time. No fitted offset, no pitch tuning.
    target = 2 * tx
    j = np.clip(np.searchsorted(ty, target), 1, len(ty) - 1)
    j -= np.abs(target - ty[j - 1]) <= np.abs(target - ty[j])
    available = (target >= ty[0]) & (target <= ty[-1])
    fx, fy = fx[available], fy[j[available]]
    both = (fx > 0) & (fy > 0)
    signed = 1200 * np.log2(fy[both] / fx[both])
    cents = np.abs(signed)
    all_cents.extend(cents.tolist()); all_signed.extend(signed.tolist())
    rows.append({**item, 'frames': len(fx), 'bothVoiced': int(both.sum()),
                 'sourceVoiced': int((fx > 0).sum()), 'outputVoiced': int((fy > 0).sum()),
                 'voicingDisagreements': int(((fx > 0) != (fy > 0)).sum()),
                 'over100Cents': int((cents > 100).sum()), 'over600Cents': int((cents > 600).sum()),
                 'medianAbsoluteCents': float(np.median(cents)), 'p95AbsoluteCents': float(np.percentile(cents, 95)),
                 'medianSignedCents': float(np.median(signed))})
    if len(rows) % 80 == 0:
        print(f'Scored {len(rows)}/480 clips', flush=True)

frames = sum(r['frames'] for r in rows)
both = sum(r['bothVoiced'] for r in rows)
summary = {k: sum(r[k] for r in rows) for k in ['frames', 'bothVoiced', 'sourceVoiced', 'outputVoiced', 'voicingDisagreements', 'over100Cents', 'over600Cents']}
summary.update({'clips': len(rows), 'speakers': len({r['path'].split('/')[1] for r in rows}),
                'medianAbsoluteCents': float(np.median(all_cents)), 'p95AbsoluteCents': float(np.percentile(all_cents, 95)),
                'medianSignedCents': float(np.median(all_signed)),
                'over100CentsPct': 100 * summary['over100Cents'] / both,
                'voicingDisagreementPct': 100 * summary['voicingDisagreements'] / frames})
result_file.write_text(json.dumps({'method': 'Praat autocorrelation 60-1000 Hz, 10 ms hop; compare nearest output frame at twice source time; no fitted offset. Jointly voiced denominator for pitch; all compared frames for voicing. Not a ground-truth or perceptual-quality estimate.',
    'versions': {'numpy': np.__version__, 'parselmouth': parselmouth.__version__, 'soundfile': sf.__version__},
    'summary': summary, 'recordings': rows, 'tones': render['tones'], 'short': render['short'],
    'longest': render['longest'], 'machine': {k: render[k] for k in ['node', 'platform', 'cpu', 'logicalCpus', 'memoryGiB']}}, indent=2) + '\n')
print(json.dumps(summary, indent=2))
