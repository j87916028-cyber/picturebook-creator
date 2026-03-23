# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**繪本有聲書創作工坊 (Picturebook Creator)** — An AI-powered web app for generating interactive children's picture book stories with voice narration and illustrations. Users create characters, describe a scene, and the system generates a complete story script, audio per line, and a scene image.

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
docker-compose up --build
# Backend: http://localhost:8001
# Frontend: http://localhost:3070
```

On Windows, `start.bat` opens both services in separate command windows.

## Architecture

### Stack
- **Backend:** Python 3.11 / FastAPI / Uvicorn — `backend/main.py`
- **Frontend:** TypeScript / React 18 / Vite — `frontend/src/`
- **Serving:** Nginx reverse-proxies `/api/*` to the backend; all other routes serve the SPA
- **No database** — fully stateless

### Backend API (`backend/main.py`)

Four endpoints drive the entire app:

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `GET /api/voices` | List 13 available voice options |
| `POST /api/generate-script` | Generate story dialogue (characters + scene → JSON script) |
| `POST /api/generate-voice` | Convert text to audio (base64 wav/mp3) |
| `POST /api/generate-image` | Generate scene illustration (URL or base64) |

**Script generation** calls MiniMax `MiniMax-M2.7` with a structured prompt that outputs JSON. The response may include a `<think>` block which is stripped with regex before JSON parsing.

**Voice synthesis** primary path is Groq Orpheus TTS; fallback is Microsoft Edge TTS (`edge-tts`).

**Image generation** primary path is HuggingFace `FLUX.1-schnell`; fallback is Pollinations.ai (no auth needed).

All external calls use `httpx` with explicit timeouts (90 s LLM, 60 s image, 30 s TTS).

### Frontend Components (`frontend/src/`)

```
App.tsx               — State root; orchestrates the full generation flow
types/index.ts        — Shared TypeScript interfaces (Character, ScriptLine, ScriptResponse)
components/
  CharacterPanel.tsx  — Character creation form & list
  CharacterCard.tsx   — Single character display
  SceneEditor.tsx     — Drop-zone, description input, style selector, Generate button
  SceneOutput.tsx     — Script display + audio player (auto-advances between lines)
index.css             — All styling (responsive CSS grid, sticky sidebar)
```

State lives in `App.tsx`; no external state library. Drag-and-drop (character → scene) uses `@dnd-kit`. Generation requests support cancellation via `AbortController`.

### Data Flow

1. User creates characters (emoji, name, personality, voice).
2. User drops characters into the scene editor, writes a description (≤500 chars), and picks a story style.
3. `POST /api/generate-script` → MiniMax LLM → parsed JSON `ScriptLine[]`.
4. For each line, `POST /api/generate-voice` → audio base64.
5. `POST /api/generate-image` → scene illustration.
6. `SceneOutput` renders the script with per-line audio playback.

## Environment Variables

Copy `backend/.env.example` to `backend/.env`:

| Variable | Required | Purpose |
|---|---|---|
| `MINIMAX_API_KEY` | **Yes** | Story script generation (MiniMax LLM) |
| `GROQ_API_KEY` | No | Primary TTS (falls back to Edge TTS) |
| `HUGGINGFACE_API_KEY` | No | Image generation (falls back to Pollinations.ai) |
| `GEMINI_API_KEY` | No | Available but not currently used |
| `CORS_ORIGINS` | No | Comma-separated allowed origins (default: localhost:5173,localhost:3000) |

## Key Implementation Notes

- The LLM prompt enforces max 20 Chinese characters per dialogue line and requires every character to have at least one line.
- `ScriptLine.audio_base64` is populated after generation; components render without it and add audio when ready.
- Voice text is capped at 200 chars on the backend; scene description at 500 chars; image prompt at 1000 chars — all validated with Pydantic.
- Nginx `client_max_body_size` is 2 MB.
