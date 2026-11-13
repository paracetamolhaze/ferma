# FERMA reels: generated ball-physics videos

Each video is generated from scratch: random format, rules, numbers, colours, arena and sound.
The same seed always gives the same video. Nothing is copied from other accounts, and the "guess the song"
melodies are public-domain (folk songs, Beethoven, Grieg, etc.).

## Sounds

All sounds are real recordings under CC0 (public domain, no attribution needed), in `sounds/`
(48 kHz mono WAV, trimmed and peak-normalised; source URL for every file in `sounds/credits.json`):

- Instruments, pitch-shifted from the nearest recorded note: marimba, kalimba (Tanzania mbira), glockenspiel,
  vibraphone, xylophone, concert harp, Kawai grand piano, hand chimes — from
  [VCSL](https://github.com/sgossner/VCSL) (Versilian Community Sample Library, CC0).
- Percussion: woodblock, claves, bongos, crash cymbal, timpani, bass drum, mark tree (wind chimes), gong, triangle — VCSL.
- Effects: glass breaking, bubble pops, explosions, glitch, whoosh — [Freesound](https://freesound.org), CC0 only
  (the build script checks the licence on each sound page before downloading).

Rebuild: `python -I D:/ferma-reels/sounds_build.py <vcsl-tree.json>` then `python -I D:/ferma-reels/pitch_fix.py`
(VCSL names some instruments with C3 = middle C; the fix script checks the real pitch of every sample).

```bash
node generate.mjs <format|random> [seed] --out D:/ferma-reels/samples
node generate.mjs race 103 --out D:/ferma-reels/dev --stills 5,20,40   # quick JPEG frames, no encoding
```

Output: `<format>-<seed>.mp4` (1080×1920, 60 fps, H.264 + AAC) and `<format>-<seed>.json` (caption + parameters).

| format | what happens | what the planner tunes |
|---|---|---|
| `race` | 2–3 lanes break floors with HP; ×100 / ×5 / +1,000 per floor | floor HP so the underdog wins or loses by < 1 s |
| `escape` | each escaped ball returns as 2–3 balls; ring bursts at 1,024–2,500 | gap size so the burst lands at ~40–47 s |
| `royale` | 6–10 big balls (mochi faces or numbers), rotating exit, last one inside wins | gap + layout so eliminations are spread out and the final duel lasts 4–12 s |
| `wall` | multiplier pads (+1 every touch) fire balls at a core with HP | HP read off the damage curve so it breaks at ~39–47 s |
| `territory` | 1 ball vs 100–500 balls repaint a grid (same rules for both); the lone ball doubles on a timer; majority at 0:00 wins | doubling interval so the result is ~49–51%, usually a late comeback |
| `melody` | each bounce plays the next note; the ball grows until it fills the circle | gravity so the song ends at ~40–50 s |

Load: one video at a time, 3 encoder threads, below-normal priority; when OBS or Dota is running on
Windows the process drops to idle priority (`REELS_PRIORITY=idle` forces it, `REELS_THREADS` changes threads).
Needs `ffmpeg` in PATH (or `FFMPEG=<path>`).

Physics randomness (`r`) and visual/sound randomness (`fx`) are separate generators on purpose:
the planner simulates without drawing or sound, and the final render must reach exactly the same result.

## In FERMA

The autopilot engine (`docker/autopilot.mjs`) renders a reel for every planned `reel` item (kind = Instagram trial reel,
5 a day by default, 9:00–23:00 profile time), asks the GPT bridge for a fresh English caption (falls back to the
generator's own), uploads the MP4 and hands it to Zernio with `trialParams.graduationStrategy = MANUAL`.
Which profiles get reels: `REELS` in `docker.env` (`off`, `on`, or profile names). The video file is removed from
storage once Zernio reports the reel published, failed or skipped.
