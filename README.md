# smoothcomp-scrubber-ui

A web UI for [smoothcomp-scrubber](https://github.com/deloachcd/smoothcomp-scrubber). Browse your video files, manage saved competitor lists, run scans, watch progress live, and cut clips — all from the browser.

## Build

```sh
git clone https://github.com/Felttrip/smoothcomp-scrubber-ui.git
cd smoothcomp-scrubber-ui
docker build -t local/scrubber-ui .
```

The image is self-contained — it builds FFmpeg, OpenCV, and Tesseract from scratch and fetches the scrubber scripts directly from GitHub. No other images need to be built first.

## Run

```sh
docker run -d \
  --name scrubber-ui \
  -p 8080:8080 \
  -v /path/to/your/videos:/videos:ro \
  -v /path/to/outputs:/outputs \
  -v /path/to/config:/config \
  local/scrubber-ui
```

Then open `http://localhost:8080` in your browser.

## Volumes

| Mount | Purpose |
|-------|---------|
| `/videos` | Read-only source — the UI will browse all video files here |
| `/outputs` | Results CSVs and clips are written here |
| `/config` | Saved competitor lists are persisted here as JSON |

## Unraid setup

1. In Unraid, go to **Docker > Add Container**
2. Set the repository to `local/scrubber-ui`
3. Add three path mappings:
   - `/videos` → your media share (read-only)
   - `/outputs` → a share for results and clips
   - `/config` → a small share for saved lists
4. Add port mapping: `8080` → `8080`
5. Apply and start

## Workflow

1. **Competitor Lists** — create a saved list of names to search for
2. **Scan Videos** — select a competitor list, tick the video files to scan, configure interval and gap tolerance, then click Start Scan
3. Watch the live log as the scan runs
4. **Make Clips** — once a scan is done, select its results file, set padding, and click Make Clips
