# Keep the recorded voice when channels cancel

At baseline `d8513a3`, ToneMirror averaged every file channel. A valid stereo
recording with the same voice at opposite polarity became exact digital
silence: **227 voiced frames became zero** in both Chromium and Firefox.
The import succeeded and replaced the previous useful clip.

Open **File channels**, choose **Channel 1** (or another channel), then load
an audio file. The choice applies to the next file, in the tab selected when
loading starts. Loaded labels include the selected channel and original
channel count. To compare two channels from one recording, load that file
once as Reference and once as Your attempt, choosing a channel each time.

**Mix all channels** remains the default. A mix that loses more than 40 dB
of RMS level relative to the strongest input channel now reports cancellation
and keeps the previous clip. The guard ignores numerical silence below
1e-6 RMS; actual silence remains valid audio. This threshold detects near-total
cancellation, not every phase problem. ToneMirror does not guess the intended
speaker, separate overlapping voices, or repair a partly cancelled mix.
An unavailable channel also keeps the previous clip and names the file's
actual channel count.

| Native decoder control | Before | After |
| --- | --- | --- |
| Opposite-polarity stereo, default mix | Silence replaces clip; 0 voiced frames | Actionable error; previous clip retained |
| Same file, Channel 1 or Channel 2 | No channel selection | 227 voiced frames on either channel |
| Different recorded tones routed to separate channels | Averaged together | Each selected channel equals its independent FFmpeg mono split |
| Change channel and tab while decoding | No channel selection | Original channel and destination retained |

[Before](before/phase.png), [cancellation recovery](after/phase-error.png),
[channel controls](after/channels.png), and [phone workflow](after/mobile.png)
are unedited production-app screenshots. The desktop uses the existing dark
theme; the phone uses the existing light theme.

## Recorded source and native controls

The source is the already bundled [Wolfdog (2019) recording](https://commons.wikimedia.org/wiki/File:FourMandarinTones.ogg),
**CC BY-SA 4.0**, SHA-256
`e857c893662741a9c99e527a1c54df52eb386fb83df021cb9a42faee77af9049`.
Its original credit and source scope are retained in [source.json](source.json).
The source identifies one speaker's four Mandarin *ma* tones; it supplies
neither verified native-speaker status nor F0 ground truth.

[prepare.py](prepare.py) uses FFmpeg 8.0 to make five float WAV controls:

- Average the source to mono, then route that voice and its polarity inverse
  to two channels of a stereo WAV.
- Excerpt recorded tone 1 and recorded tone 4, pad each to one second, and
  route them to separate channels. Split them independently with FFmpeg.

These are **derived channel controls**, not naturally captured stereo
conversations or different speakers. No voice, pitch shift or time stretch
is generated. The derivative audio remains CC BY-SA 4.0; ignored cache files
can be regenerated from the credited bundled source. The manifest records
filters, producer version, file hashes, duration, sample rate and channel count.

[browser.mjs](browser.mjs) imports those WAVs through the real native decoder
and pitch worker. Chromium and Firefox each run at 1440 and 375 pixels. Every
page disconnects after loading, before the first import. The observer copies
actual worker input and results without changing them.

The [before](before/browser.json) and [after](after/browser.json) receipts show:

- All four workflows reproduce zero RMS and zero voiced frames before.
- Both explicit channels retain all 227 voiced frames after. Channel 1's
  decoded PCM equals the mono control byte for byte; channel 2 has opposite
  polarity and identical voicing and median F0. No F0 accuracy claim follows.
- Each separately selected tone equals its independent FFmpeg split byte for
  byte. Both appear together as Reference and Your attempt with channel labels.
- Sixteen actual WAV downloads contain exactly the selected mono PCM at its
  decoded sample rate. Downloads do not preserve the original multichannel
  container; they export the focused, selected audio. Native playback buffers
  and saved-reference reloads also match the selected PCM exactly.
- The cancellation and missing-channel errors retain the previous loaded PCM.
  There are no page errors, CSP violations, external requests or horizontal
  overflow. Four expanded-control accessibility scans report no violations.

The regular browser suite also holds a real decode while the user changes
channel and tab, and checks cancellation recovery using a native stereo WAV.
The small 220 Hz waveform in that regression is explicitly synthetic; the
study above uses recorded speech. Neither is a microphone hardware study or
an evaluation of pronunciation grades. Eight channels remain the import limit.

## Reproduce

```sh
npm ci
python3 studies/file-channels/prepare.py
npm run build
npm run preview -- --host 127.0.0.1 --port 4258 --strictPort
```

In a second terminal:

```sh
node studies/file-channels/browser.mjs http://127.0.0.1:4258/tonemirror/ studies/file-channels/after after
```

The producer requires FFmpeg/ffprobe. Browser engines are supplied by the
project's existing Playwright installation. For the baseline, build archive
`d8513a3` separately, serve it, and pass `before` as the final argument. This
change leaves pitch extraction, DTW matching and the score unchanged.
