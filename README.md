# Affiliate Editor — Dead Space Cutter Backend

This is the Railway backend that powers the AI video cutting tool.

## What it does
1. Accepts up to 20 video uploads
2. Extracts audio and sends it to AssemblyAI
3. Gets word-level timestamps back
4. Uses FFmpeg to cut out silence between words
5. Returns edited videos for download
6. Auto-deletes all files after 24 hours

## Files
- `server.js` — Express server, handles uploads and downloads
- `processor.js` — AssemblyAI + FFmpeg logic
- `package.json` — Node.js dependencies
- `nixpacks.toml` — Tells Railway to install FFmpeg

## Environment Variable to set in Railway
`ASSEMBLYAI_API_KEY` = your AssemblyAI key

## Endpoints
- `GET /` — health check
- `POST /process` — upload videos (field name: `videos`, max 20)
- `GET /download/:filename` — download a processed video

## Settings you can send with each upload
- `silenceThreshold` — minimum gap in seconds to cut (default: 0.3)
- `leadIn` — seconds to keep before speech starts (default: 0.05)
- `leadOut` — seconds to keep after speech ends (default: 0.1)
