# Crop Tool — Design Spec
Date: 2026-05-30

## Overview

A static single-page web app that lets video editors crop 9:16 videos to 4:5 aspect ratio entirely in their browser. No server, no login, no install. Hosted on GitHub Pages as a permanent URL.

## Problem

Editors (Justine, Clarence, Jericho) produce 9:16 footage that needs to be cropped to 4:5 for Meta ads. Currently a manual step. This tool removes that friction with a drag-drop-download flow.

## Architecture

- **Single HTML page** with a small JS bundle (no framework)
- **FFmpeg.wasm (single-threaded)** runs the crop inside the editor's browser tab
- **GitHub Pages** hosts the static files — free, always-on, no Mike's machine required
- All video data stays on the editor's machine; nothing is uploaded anywhere

## Crop Logic

- Input: 9:16 video (e.g. 1080x1920)
- Output: 4:5 video (e.g. 1080x1350) — keep full width, trim equal slices from top and bottom
- FFmpeg filter: `crop=iw:iw*5/4:0:(ih-iw*5/4)/2`
- Audio: copied without re-encoding (fast, lossless)
- Output filename: `<original-name>_4x5.mp4`

## UI Flow

1. **Drop zone** — full-width centered box: "Drop your 9:16 video here" (click to browse also works)
2. **FFmpeg loading bar** — "Loading FFmpeg..." with progress (one-time ~30s first visit, instant after due to browser cache)
3. **Processing bar** — "Cropping..." with progress (10–30s depending on clip length)
4. **Download button** — big green "Download 4:5 Video" button appears when done
5. **Reset** — "Crop another video" link resets to drop zone

No settings, no options, no accounts. One job, one screen.

## File Support

- Input formats: MP4, MOV, MKV
- Output format: MP4
- Max file size: browser memory limit (~2GB practical ceiling; typical 60s clip is under 500MB)

## Deployment

1. Push code to a public GitHub repo (e.g. `github.com/mike-deng/crop-tool`)
2. Repo Settings → Pages → Source: `main` branch, root `/`
3. GitHub provides a permanent URL (e.g. `https://mike-deng.github.io/crop-tool`)
4. Share that URL with editors once — it never changes
5. Future updates: push to `main`, live within minutes

## Out of Scope

- Smart/manual crop positioning (center crop only)
- Batch processing (one video at a time)
- Authentication or access control
- Any server-side processing
