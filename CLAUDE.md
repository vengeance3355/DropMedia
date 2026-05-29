# DropMedia — Project Context

## What this is
Electron desktop app for multi-platform video downloading (yt-dlp + ffmpeg).
- **Main process**: `src/main/` — TypeScript, Node.js APIs, yt-dlp/ffmpeg spawning
- **Renderer**: `src/renderer/src/` — React 18 + Tailwind + Zustand store
- **Admin panel**: `admin-panel/` — Next.js App Router, reads Supabase logs/stats
- **Backend**: Supabase — `error_logs` and `stats` tables (see `supabase/schema.sql`)

## Stack
- electron-vite + Electron 33
- React 18, TypeScript 5, Tailwind 3
- Zustand for renderer state (`src/renderer/src/store/`)
- electron-store for persistent settings
- Supabase for remote telemetry (admin bridge: `src/main/adminBridge.ts`)
- yt-dlp + ffmpeg (installer: `src/main/installer.ts`)

## Build & run
```bash
npm run dev          # dev mode (hot reload)
npm run build        # production build
npm run dist:linux   # package for Linux
npm run dist:win     # package for Windows
npm run release      # patch release (bumps version + git tag)
```

## Key conventions
- IPC: main ↔ renderer via `src/preload/index.ts` — always type the channel
- Downloader logic lives in `src/main/downloader.ts`
- Logging (local + remote) in `src/main/logger.ts`
- Cookie support: `src/main/cookies.ts`
- Admin panel API routes under `admin-panel/src/app/api/`

## Supabase tables
- `error_logs` — device errors, crashes, download failures
- `stats` — per-device download stats and usage metrics

## What to avoid
- Don't add Supabase calls directly in renderer — use IPC → main → adminBridge
- Don't block the main process with sync I/O during downloads
- Don't expose secrets in renderer/preload context
