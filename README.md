# Fixed-wing UDE: ACC 2027 companion site

Companion to *Physics-Structured Surrogate Modeling of Commanded Fixed-Wing UAV
Dynamics Using Universal Differential Equations* (ACC 2027). Three static pages, dark,
in Purdue colours and type, served at <https://cognipilot.github.io/fixedwing-ude/>.

- `site/index.html` — **Home**: the flight video and an introduction to the Purdue UAS
  Research and Test facility (PURT).
- `site/results.html` — **Results**: pick a flight and a horizon and step through the
  paper's stored held-out forecasts against the measurement, with the score per method.
- `site/data.html` — **Data**: the eight flights as a table, what a record contains,
  and a link to the code. The NPZ, CSV and rosbag downloads are not open yet: the
  buttons report that. `site/public/release/` (the exported records) is ignored by git
  until the data is released.

## Run it

```bash
python3 site/serve.py    # http://127.0.0.1:8765/
```

No build step and no dependencies. `.github/workflows/pages.yml` deploys `site/` to
GitHub Pages on every push to `main`.

## The video

The home page loops `site/public/media/purt_flight.mp4`: a 28-second cut (186 s to
214 s) of the FPV chase of the Sport Cub in PURT, at the source's 3840 × 2160, 60 fps.
It is a stream copy, so nothing is re-encoded; only the audio is dropped. The poster
is a frame from 202 s. To cut a different stretch from the source file:

```bash
ffmpeg -ss 186 -t 28 -i source.mov -map 0:v:0 -c:v copy -an -write_tmcd 0 \
  -movflags +faststart site/public/media/purt_flight.mp4
ffmpeg -ss 202 -i source.mov -frames:v 1 -vf scale=1920:1080 -q:v 3 site/public/media/purt_flight_poster.jpg
```

The source runs at about 2.6 MB per second, so keep the cut under about 35 s to stay
below GitHub's 100 MB per-file limit.

## Layout

- `site/src/styles.css` — the one stylesheet. Fonts are Acumin Pro and United Sans
  where installed, otherwise Libre Franklin and Barlow Condensed from Google Fonts.
- `site/src/app.js`, `charts.js`, `data.js` — the results page.
- `site/src/release.js` — the data page.
- `tools/export_site_data.py` — the eight flights (float32 tables) and their fit /
  development / test arcs, plus the score scales.
- `tools/export_forecasts.py` — the paper's stored forecasts (`forecasts/*.f32`,
  `forecasts.json`).
- `tools/export_release.py` — the downloadable records (NPZ and CSV) and
  `release.json` for the data page.

The tools read the reproducibility package at `../ACC_2027`; re-run them whenever it
changes. Nothing is simulated in the browser: every forecast shown is one the paper's
tables and figures were computed from. No data download is open yet. The records exported by `tools/export_release.py` live
in `site/public/release/`, which git ignores, and the rosbags (609 MB) have no public
host. To release: remove that line from `.gitignore`, set `ROSBAG_URL` in
`tools/export_release.py`, and turn the buttons back into links in `site/src/release.js`.
