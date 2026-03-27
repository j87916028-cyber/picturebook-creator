# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**繪本有聲書創作工坊 (Picturebook Creator)** — An AI-powered web app for generating interactive children's picture book stories with voice narration and illustrations. Users create characters, describe a scene, and the system generates a complete story script, audio per line, and a scene image. Projects are persisted to PostgreSQL.

## Development Commands

### Local Development (without Docker)

**Backend:**
```bash
cd backend
pip install -r requirements.txt
cp .env.example .env   # then fill in API keys
uvicorn main:app --reload --port 8000
```

**Frontend:**
```bash
cd frontend
npm install
npm run dev            # Dev server on http://localhost:5173
npm run build          # Production build → dist/
npm run preview        # Preview production build
```

### Docker (recommended)
```bash
docker compose up --build
# Backend: http://localhost:8001
# Frontend: http://localhost:3070
```

On Windows, `start.bat` opens both services in separate command windows.

## Architecture

### Stack
- **Backend:** Python 3.11 / FastAPI / Uvicorn — `backend/main.py`
- **Frontend:** TypeScript / React 18 / Vite — `frontend/src/`
- **Database:** PostgreSQL 16 via `asyncpg`; schema created at startup via `CREATE TABLE IF NOT EXISTS`
- **Serving:** Nginx reverse-proxies `/api/*` to the backend; all other routes serve the SPA

### Backend API (`backend/main.py`)

Key endpoint groups:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Service availability + API key status (booleans only) |
| `GET /api/voices` | List available voices |
| `GET /api/voices/{id}/preview` | Stream TTS preview audio |
| `POST /api/generate-script` | LLM → JSON script (MiniMax primary, Groq fallback) |
| `POST /api/generate-voice` | Text → base64 audio (LRU-cached, 200 entries) |
| `POST /api/generate-image` | Scene illustration (HuggingFace → Pollinations → Pillow) |
| `POST /api/recognize-image` | Groq vision → Chinese scene description |
| `POST /api/transcribe` | Groq Whisper → text |
| `POST /api/suggest-*` | AI suggestions: personality, visual, next-scene, title, line, rephrase |
| `GET/POST/PATCH/DELETE /api/projects` | Project CRUD |
| `PUT /api/projects/{id}/scenes` | Auto-save scenes + characters + cover thumbnail |
| `GET /api/projects/{id}/export` | Export as pdf/epub/html/mp3/txt |

**Voice synthesis chain** (in priority order):
1. iFlytek (科大訊飛) — if `XFYUN_*` keys set; best Chinese quality
2. Microsoft Edge TTS (`edge-tts`) — always available, Taiwan accent
3. Groq Orpheus — English voices only, last-resort fallback

**Script generation** calls MiniMax `MiniMax-M2.7` with a structured prompt that outputs JSON. The response may include a `<think>` block stripped by regex before JSON parsing. Falls back to Groq `llama-3.1-8b-instant`.

**Image generation** chain: HuggingFace `FLUX.1-schnell` → Pollinations.ai → Pillow local fallback (geometric placeholder).

All external calls use `httpx` with explicit timeouts (90 s LLM, 60 s image, 30 s TTS).

### Rate limiters (`_RateLimiter`, per-IP sliding window)

| Limiter | Limit | Endpoints |
|---|---|---|
| `_rl_script` | 10/min | generate-script |
| `_rl_voice` | 60/min | generate-voice, voice preview |
| `_rl_image` | 10/min | generate-image |
| `_rl_suggest_char` | 20/min | suggest-personality, suggest-visual-description |
| `_rl_suggest_scene` | 15/min | suggest-next-scene, suggest-mood, suggest-title, generate-summary |
| `_rl_suggest_line` | 20/min | rephrase-line, suggest-line |
| `_rl_title` | 15/min | generate-title |
| `_rl_recognize` | 10/min | recognize-image |
| `_rl_transcribe` | 10/min | transcribe |
| `_rl_export` | 5/min | export |
| `_rl_project` | 60/min | all project CRUD |

### Frontend Components (`frontend/src/`)

```
App.tsx               — State root; orchestrates the full generation flow
types/index.ts        — Shared TypeScript interfaces (Character, ScriptLine, Scene, etc.)
components/
  CharacterPanel.tsx  — Character creation form (emoji, name, personality, voice, color)
  CharacterCard.tsx   — Single character display card
  SceneEditor.tsx     — Drop-zone, description textarea, style/length selectors, Generate button
  SceneOutput.tsx     — Scene cards with script, per-line audio, image, inline editing
  PlaybackModal.tsx   — Full-screen cross-scene audio playback (speed, volume, loop, keyboard shortcuts)
  ProjectPanel.tsx    — Project list, create/load/rename/delete/duplicate
index.css             — All styling (CSS custom properties, responsive grid)
```

State lives in `App.tsx`; no external state library. Drag-and-drop uses `@dnd-kit`. Generation requests support cancellation via `AbortController`. Voice tasks run with `throttled()` (max 4 concurrent).

### Data Flow

1. User creates characters (emoji, name, personality, voice, color).
2. User drops characters into the scene editor, writes a description (≤500 chars), picks style and line length.
3. `POST /api/generate-script` → LLM → parsed `ScriptLine[]`.
4. Voice tasks run in parallel (max 4): `POST /api/generate-voice` → audio base64, stored on each `ScriptLine`.
5. `POST /api/generate-image` → scene illustration stored on the `Scene`.
6. Auto-save fires (debounced 1.5 s): `PUT /api/projects/{id}/scenes`.
7. `SceneOutput` renders the script with per-line audio, inline editing, and a full playback modal.

### localStorage keys (frontend)

| Key | Purpose |
|---|---|
| `scene_style` | Last-used story style (e.g. "溫馨童趣") |
| `scene_line_length` | Last-used line length ('short'/'standard'/'long') |
| `scene_image_style` | Last-used image style English value |
| `scene_description_draft` | In-progress description; cleared on successful generation |

## Environment Variables

Copy `backend/.env.example` to `backend/.env`:

| Variable | Required | Purpose |
|---|---|---|
| `MINIMAX_API_KEY` | **Yes** | Story script generation (primary LLM) |
| `GROQ_API_KEY` | No | Script fallback LLM + Groq Whisper transcription + Orpheus TTS fallback |
| `HUGGINGFACE_API_KEY` | No | Image generation (FLUX.1-schnell) |
| `POLLINATIONS_API_KEY` | No | Image generation fallback |
| `XFYUN_APP_ID` | No | iFlytek TTS (best Chinese quality; all three vars required together) |
| `XFYUN_API_KEY` | No | iFlytek TTS |
| `XFYUN_API_SECRET` | No | iFlytek TTS |
| `GEMINI_API_KEY` | No | Reserved; not currently used |
| `DATABASE_URL` | No | PostgreSQL connection string (default set in docker-compose.yml) |
| `CORS_ORIGINS` | No | Comma-separated allowed origins (default: localhost:5173,localhost:3000) |

## Key Implementation Notes

- Export formats (pdf/epub/html/mp3/txt) all run via `loop.run_in_executor()` — they are CPU-bound and must not block the event loop.
- The TTS LRU cache key is a `(voice_id, emotion, text)` tuple — not a string — to prevent false hits when `text` contains `:`.
- `_client_ip()` reads `X-Real-IP` (set by Nginx) first; never uses the first entry of `X-Forwarded-For` (client-spoofable).
- `list_projects` caps results at `LIMIT 200` to bound the expensive JOIN + thumbnail payload.
- All `suggest-*` AI endpoints accept a `style` parameter; frontend reads it from `localStorage['scene_style']`.
- Voice text is capped at 200 chars; scene description at 500 chars; image prompt at 1000 chars — all validated with Pydantic.
- `_validate_uuid()` is called on every path parameter that accepts a project UUID.
- Nginx `client_max_body_size` is 50 MB.
