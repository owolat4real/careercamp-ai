# Self-Hosted Talking-Head Video (SadTalker)

Self-hosted, open-source primary engine for Cinematic Mode's talking-avatar
video in the Avatar Interview feature, with HeyGen as external fallback.
See `cs_fixed/routes/avatarInterview.js`'s `/cinematic/video` route for the
actual primary/fallback wiring, and `cs_fixed/services/talkingHead.js` for
the client that calls this server.

## What this is (and isn't)

This wraps [SadTalker](https://github.com/OpenTalker/SadTalker) — a real,
existing, open-source talking-head video model. It is **not** a model
built from scratch, and it does not out-perform HeyGen's commercial
quality. It exists so Cinematic Mode has a free, self-hosted option before
falling back to a paid external API.

## Setup

```
cd careercamp-ai/talkinghead
./setup.sh
```

This clones SadTalker into `../_sadtalker_src/` (gitignored — it's a large
vendored dependency with its own venv, model checkpoints, and a standalone
ffprobe binary, none of which belong in this git repo), applies
`patches/sadtalker-py312-windows-fixes.patch`, and downloads everything
needed. See `setup.sh` for the exact steps if you need to reproduce this
by hand or adapt it for a different OS/deploy target.

Start the server (after setup):
```
cd ../_sadtalker_src && ./venv/Scripts/python.exe talkinghead_server.py
```
Runs on port 3004. Set `TALKINGHEAD_BASE_URL` in cs_fixed's `.env` if it's
hosted somewhere other than `http://localhost:3004`.

## Real, load-bearing limitations

**No GPU, no live interview use.** Measured on CPU-only hardware:
~11-12 seconds *per rendered frame* at 25fps — an 8-9 minute render for a
~3.5 second clip. This is fine for a background/practice-mode generation,
but far too slow for a live back-and-forth interview turn. A GPU would
speed this up dramatically (SadTalker on a modern GPU commonly renders
faster than real-time), but that's a hosting decision — this code doesn't
require a GPU to run, it just needs one to be *usable* for live interviews.

**No real persona photos exist yet.** None of the 12 interview personas in
`services/avatarInterview.js` have a real photo — only a name, color, and
style. Drop a licensed photo at `../_sadtalker_src/personas/<persona_id>.png`
(e.g. `alex.png`) to enable a given persona; until then, every request
falls back to the bundled SadTalker example portrait, honestly reported
via the `X-Persona-Image-Source: placeholder` response header (and
`personaImageSource` in the job status JSON) so callers never mistake a
placeholder for a real persona photo.

## Why the patches were needed

SadTalker's requirements pin old package versions with no Python 3.12
wheels, and its own source uses numpy/torchvision APIs removed in newer
releases. `patches/sadtalker-py312-windows-fixes.patch` fixes:
- Deprecated `np.float`/`np.int`/etc. aliases (removed in NumPy 1.24+)
- A ragged-array construction that NumPy now rejects instead of warns on
- `basicsr`'s import of `torchvision.transforms.functional_tensor` (moved
  in newer torchvision)
- `os.system()`-based ffmpeg calls that failed with a generic Windows
  error in this specific process chain — replaced with `subprocess.run()`,
  which is also just better practice (avoids shell-quoting risk)

`talkinghead_server.py` additionally configures `pydub` (used internally
by SadTalker's own audio-processing step) to find `ffmpeg`/`ffprobe`
explicitly, since neither is installed system-wide and `imageio-ffmpeg`
(already a dependency) only bundles `ffmpeg`, not `ffprobe`.
