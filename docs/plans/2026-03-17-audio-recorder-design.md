# Audio Recorder Design

## Recommended Approach

This tool uses Electron so the UI can be built with HTML/CSS/JS while still writing files locally without a remote backend. That gives a cleaner interface than Python desktop UI and keeps startup simple with a single batch file.

## Core Model

Each project lives under `data/projects/<project-id>/` and stores:

- `project.json` for project metadata and ordered slot metadata
- `segments/` for individual recorded files
- `exports/` for merged output
- `temp/` for conversion and preview artifacts

Slots are order-sensitive. Deleting audio clears only the file. Deleting a slot is only allowed when the slot is empty, then later slots shift upward and filenames are renamed to preserve sequence order.

## Recording And Export

The renderer records microphone audio with `MediaRecorder` and passes the raw buffer to the main process. The main process converts it to the project format with `ffmpeg-static`, writes ordered filenames like `01-intro.mp3`, and can merge all recorded segments into a preview or export file at any time.

Merged output supports project-level preprocessing settings. Before concatenation, each recorded segment can be trimmed to remove only leading and trailing silence, then a fixed silence gap is inserted between adjacent segments. This keeps the raw recorded files unchanged while making final playback more natural and consistent.

## UI Direction

The interface uses a warm editorial workstation style instead of a generic dashboard: soft paper tones, glass panels, bold section cards, large typography, and focused recorder actions. The layout keeps projects on the left and the active slot workflow on the right for fast sequential recording.
