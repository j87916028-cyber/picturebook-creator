import email.utils
import hashlib
import hmac
import html
import io
import os
import re
import json
import math
import struct
import time
import uuid
import asyncio
import random
import base64
import glob as _glob
import tempfile
import zipfile
import httpx
import logging
import urllib.parse
from collections import defaultdict, deque, OrderedDict
from contextlib import asynccontextmanager
import edge_tts

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Query
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, Response
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Annotated, Any, Dict, Literal
from dotenv import load_dotenv

load_dotenv()

# Detect optional heavy dependencies once at startup so the health endpoint
# can report accurate availability without importing them on every request.
try:
    import PIL  # noqa: F401
    _PILLOW_AVAILABLE = True
except ImportError:
    _PILLOW_AVAILABLE = False

# ── In-memory sliding-window rate limiter ────────────────────────
class _RateLimiter:
    """Per-IP sliding-window rate limiter (in-process, single-replica safe)."""

    def __init__(self, max_calls: int, window_secs: int):
        self.max_calls = max_calls
        self.window_secs = window_secs
        self._calls: dict[str, deque[float]] = defaultdict(deque)
        self._last_prune = time.monotonic()

    def is_allowed(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_secs
        bucket = self._calls[key]
        # Prune expired timestamps — O(1) popleft on deque vs O(n) pop(0) on list
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= self.max_calls:
            return False
        bucket.append(now)
        # Periodically evict stale buckets to prevent unbounded memory growth.
        # Without this, IPs that made requests and then went quiet keep their
        # expired timestamps (and their bucket entries) in memory forever.
        # The earlier check only pops timestamps for the *current* IP; all other
        # inactive IPs still hold expired timestamps until this prune runs.
        if now - self._last_prune > 300:  # every 5 minutes
            self._last_prune = now
            stale_keys = []
            for k, v in self._calls.items():
                # Drain expired timestamps from every bucket, not just the caller's.
                while v and v[0] < cutoff:
                    v.popleft()
                if not v:
                    stale_keys.append(k)
            for k in stale_keys:
                del self._calls[k]
        return True

    def time_to_next(self, key: str) -> int:
        """Seconds until the next call slot opens up for *key*.

        Call this only after ``is_allowed()`` returned ``False``.
        At that point the bucket still has ``max_calls`` valid entries;
        the oldest one expires at ``bucket[0] + window_secs``.
        """
        bucket = self._calls[key]
        if not bucket:
            return 1
        wait = bucket[0] + self.window_secs - time.monotonic()
        return max(1, int(wait) + 1)


def _rl_429(limiter: _RateLimiter, key: str, detail: str = "請求過於頻繁，請稍後再試") -> HTTPException:
    """Build a 429 HTTPException with a ``Retry-After`` header so the client
    knows exactly how many seconds to wait before retrying."""
    wait = limiter.time_to_next(key)
    return HTTPException(
        status_code=429,
        detail=detail,
        headers={"Retry-After": str(wait)},
    )


def _client_ip(request: Request) -> str:
    """Return the real client IP for per-IP rate limiting.

    Nginx sets ``X-Real-IP: $remote_addr`` — the actual TCP connection IP
    from Nginx's perspective.  This cannot be injected by the client, so it
    is the authoritative source.

    Avoid reading the *first* entry of ``X-Forwarded-For``: Nginx uses
    ``proxy_add_x_forwarded_for`` which *appends* the real IP to any
    client-supplied header.  A caller can therefore spoof the first entry
    (e.g. ``X-Forwarded-For: 1.2.3.4``) to make every request appear to
    come from a different IP and bypass per-IP rate limiting entirely.

    Fallback chain:
        1. X-Real-IP (preferred — set exclusively by our Nginx proxy)
        2. Last entry of X-Forwarded-For (also appended by Nginx, not spoofable)
        3. request.client.host (only present when running without a proxy)
    """
    real_ip = request.headers.get("X-Real-IP", "").strip()
    if real_ip:
        return real_ip
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        # The rightmost entry is appended by our trusted Nginx; never by the client.
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


# Per-endpoint limits (per IP, per minute)
_rl_script  = _RateLimiter(max_calls=10,  window_secs=60)   # LLM script gen
_rl_voice   = _RateLimiter(max_calls=60,  window_secs=60)   # TTS (many lines/scene)
_rl_image   = _RateLimiter(max_calls=10,  window_secs=60)   # Image gen
_rl_suggest_char  = _RateLimiter(max_calls=20, window_secs=60)   # Character suggestions (personality, visual)
_rl_suggest_scene = _RateLimiter(max_calls=15, window_secs=60)   # Story/scene suggestions (next-scene, mood, title, summary)
_rl_suggest_line  = _RateLimiter(max_calls=20, window_secs=60)   # Line editing (rephrase, suggest-line)
_rl_title   = _RateLimiter(max_calls=30,  window_secs=60)   # Title gen
_rl_recognize = _RateLimiter(max_calls=10, window_secs=60)  # Image recognition (AI, expensive)
_rl_transcribe = _RateLimiter(max_calls=10, window_secs=60) # Audio transcription (AI, expensive)
_rl_export  = _RateLimiter(max_calls=5,   window_secs=60)   # Export (CPU-heavy)
_rl_project = _RateLimiter(max_calls=60,  window_secs=60)   # Project CRUD (auto-save fires ~40×/min)

# ── Optional asyncpg import (graceful if not installed) ──────────
try:
    import asyncpg
    _asyncpg_available = True
except ImportError:
    asyncpg = None  # type: ignore
    _asyncpg_available = False

# ── Shared HTTP client & DB pool ─────────────────────────────────
_http_client: httpx.AsyncClient | None = None
_db_pool: Any = None  # asyncpg.Pool or None

DATABASE_URL = os.getenv("DATABASE_URL", "")

_CREATE_PROJECTS = """
CREATE TABLE IF NOT EXISTS projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(100) NOT NULL DEFAULT '未命名作品',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

_CREATE_SCENES = """
CREATE TABLE IF NOT EXISTS scenes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx         SMALLINT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  style       VARCHAR(20) NOT NULL DEFAULT '溫馨童趣',
  script      JSONB NOT NULL DEFAULT '{}',
  lines       JSONB NOT NULL DEFAULT '[]',
  image       TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, idx)
);
"""

# Migration: add characters column to existing projects tables
_ALTER_PROJECTS_CHARS = """
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS characters JSONB NOT NULL DEFAULT '[]';
"""

# Migration: add cover_image column (small thumbnail) to projects
_ALTER_PROJECTS_COVER = """
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS cover_image TEXT;
"""

# Migration: add line_length column to scenes (stores 'short'/'standard'/'long')
_ALTER_SCENES_LINE_LENGTH = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS line_length VARCHAR(20) NOT NULL DEFAULT 'standard';
"""

# Migration: add title column to scenes (user-defined short label, e.g. "開場", "結局")
_ALTER_SCENES_TITLE = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT '';
"""

# Migration: add notes column to scenes (private director/author notes, not exported)
_ALTER_SCENES_NOTES = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS notes TEXT NOT NULL DEFAULT '';
"""

# Migration: add is_locked column to scenes (prevents accidental regeneration)
_ALTER_SCENES_LOCKED = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
"""

# Migration: add image_style column to scenes so regeneration can default to
# the same style that was used when the scene was first generated, even if the
# user has since changed the global image-style selector.
_ALTER_SCENES_IMAGE_STYLE = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS image_style VARCHAR(100) NOT NULL DEFAULT '';
"""

# Migration: persist mood / age_group per scene so the regeneration form can
# pre-fill the original settings instead of always reading from localStorage.
_ALTER_SCENES_MOOD = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS mood VARCHAR(20) NOT NULL DEFAULT '';
"""

_ALTER_SCENES_AGE_GROUP = """
ALTER TABLE scenes
  ADD COLUMN IF NOT EXISTS age_group VARCHAR(20) NOT NULL DEFAULT 'child';
"""

# Indexes: created once at startup; IF NOT EXISTS makes them safe to re-run.
# idx_scenes_project_id  — speeds up every per-project query (get, save, export, delete)
#                          PostgreSQL does NOT auto-create an index for FK references.
# idx_projects_updated_at — speeds up list_projects ORDER BY updated_at DESC LIMIT 200
_IDX_SCENES_PROJECT_ID = "CREATE INDEX IF NOT EXISTS idx_scenes_project_id ON scenes (project_id);"
_IDX_PROJECTS_UPDATED_AT = "CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects (updated_at DESC);"

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_client, _db_pool
    _http_client = httpx.AsyncClient(
        limits=httpx.Limits(
            max_connections=100,
            max_keepalive_connections=20,
            keepalive_expiry=30,
        ),
        timeout=90,  # default safety net; per-call timeouts override this
    )
    logger.info("Shared httpx.AsyncClient created (limits: max_conn=100, keepalive=20)")

    if DATABASE_URL and _asyncpg_available:
        try:
            _db_pool = await asyncpg.create_pool(
                DATABASE_URL, min_size=1, max_size=5,
                command_timeout=30,  # 30 s hard cap per SQL statement; prevents hung queries from exhausting the pool
            )
            async with _db_pool.acquire() as conn:
                await conn.execute(_CREATE_PROJECTS)
                await conn.execute(_CREATE_SCENES)
                await conn.execute(_ALTER_PROJECTS_CHARS)
                await conn.execute(_ALTER_PROJECTS_COVER)
                await conn.execute(_ALTER_SCENES_LINE_LENGTH)
                await conn.execute(_ALTER_SCENES_TITLE)
                await conn.execute(_ALTER_SCENES_NOTES)
                await conn.execute(_ALTER_SCENES_LOCKED)
                await conn.execute(_ALTER_SCENES_IMAGE_STYLE)
                await conn.execute(_ALTER_SCENES_MOOD)
                await conn.execute(_ALTER_SCENES_AGE_GROUP)
                await conn.execute(_IDX_SCENES_PROJECT_ID)
                await conn.execute(_IDX_PROJECTS_UPDATED_AT)
            logger.info("PostgreSQL pool created and schema applied")
        except Exception as exc:
            logger.warning("Failed to connect to PostgreSQL: %s — DB features disabled", exc)
            _db_pool = None
    else:
        logger.info("DATABASE_URL not set or asyncpg unavailable — DB features disabled")

    yield

    await _http_client.aclose()
    logger.info("Shared httpx.AsyncClient closed")
    if _db_pool:
        await _db_pool.close()
        logger.info("PostgreSQL pool closed")

app = FastAPI(title="Picturebook Creator API", lifespan=lifespan)

# CORS origins configurable via env; fallback to localhost dev origins
_cors_origins_env = os.getenv("CORS_ORIGINS", "")
CORS_ORIGINS = (
    [o.strip() for o in _cors_origins_env.split(",") if o.strip()]
    if _cors_origins_env
    else ["http://localhost:5173", "http://localhost:3000"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "If-None-Match"],
    expose_headers=["ETag", "X-Response-Time", "Retry-After"],
)

# Compress JSON responses ≥ 1 kB.  Starlette's GZipMiddleware skips responses
# that already carry a Content-Encoding header (e.g. StreamingResponse audio),
# so binary downloads are unaffected.  The 1024-byte threshold avoids wasting
# CPU on tiny health-check or rate-limit error payloads.
app.add_middleware(GZipMiddleware, minimum_size=1024)


@app.middleware("http")
async def _add_security_and_timing_headers(request: Request, call_next):
    """Attach security headers and measure request processing time.

    Security:
    - ``X-Content-Type-Options: nosniff``   — prevents MIME-type sniffing attacks
    - ``X-Frame-Options: DENY``             — blocks this API from being framed
    - ``Referrer-Policy``                   — limits referrer leakage to same-origin

    Timing:
    - ``X-Response-Time``                   — wall-clock ms for backend processing
    - Requests taking >5 s are logged as warnings for easy triage.
    """
    start = time.monotonic()
    response = await call_next(request)
    elapsed_ms = round((time.monotonic() - start) * 1000)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["X-Response-Time"] = f"{elapsed_ms}ms"
    if elapsed_ms > 5000:
        logger.warning("Slow request: %s %s → %s in %dms", request.method, request.url.path, response.status_code, elapsed_ms)
    return response


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Convert Pydantic 422 validation errors to a human-readable Chinese string.

    FastAPI's default 422 handler returns ``detail`` as a list of error dicts
    (e.g. ``[{"loc": [...], "msg": "...", "type": "..."}]``).  When the frontend
    catches this and does ``throw new Error(body.detail ?? ...)``, the array is
    coerced to the string ``"[object Object]"`` — completely unreadable.

    This handler extracts the first validation error and returns a plain Chinese
    ``detail`` string, so any frontend ``catch`` block that reads ``body.detail``
    gets a useful message it can display directly.
    """
    errors = exc.errors()
    logger.warning("Validation error [%s %s]: %s", request.method, request.url.path, errors)
    if errors:
        first = errors[0]
        loc_parts = [str(p) for p in first.get("loc", []) if p not in ("body", "query")]
        loc_str = " → ".join(loc_parts)
        msg = first.get("msg", "格式錯誤")
        detail = f"請求格式錯誤：{loc_str}（{msg}）" if loc_str else f"請求格式錯誤：{msg}"
    else:
        detail = "請求格式錯誤"
    return JSONResponse(status_code=422, content={"detail": detail})


# ── Friendly handler for database connection errors ──────────────
# When postgres crashes or restarts mid-session, asyncpg raises
# InterfaceError / ConnectionDoesNotExistError.  Without this handler
# the user sees a raw 500 traceback.
if _asyncpg_available:
    @app.exception_handler(asyncpg.PostgresError)
    @app.exception_handler(asyncpg.InterfaceError)
    async def _db_error_handler(request: Request, exc: Exception) -> JSONResponse:
        logger.error("Database error [%s %s]: %s", request.method, request.url.path, exc)
        return JSONResponse(
            status_code=503,
            content={"detail": "資料庫暫時無法連線，請稍後再試"},
        )


MINIMAX_API_KEY = os.getenv("MINIMAX_API_KEY")
MINIMAX_BASE = "https://api.minimax.io/v1"
MINIMAX_HEADERS = {
    "Authorization": f"Bearer {MINIMAX_API_KEY}",
    "Content-Type": "application/json",
}

GROQ_API_KEY = os.getenv("GROQ_API_KEY")
GROQ_TTS_URL = "https://api.groq.com/openai/v1/audio/speech"
GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
# Fast model for short-output tasks (title, personality, visual desc) — ~5× lower latency
GROQ_FAST_MODEL = "llama-3.1-8b-instant"
# Quality model for creative/suggestion tasks that need richer reasoning
GROQ_QUALITY_MODEL = "llama-3.3-70b-versatile"

# ── 科大訊飛 TTS ────────────────────────────────────────────
XFYUN_APP_ID     = os.getenv("XFYUN_APP_ID", "")
XFYUN_API_KEY    = os.getenv("XFYUN_API_KEY", "")
XFYUN_API_SECRET = os.getenv("XFYUN_API_SECRET", "")

HUGGINGFACE_API_KEY = os.getenv("HUGGINGFACE_API_KEY", "")
HF_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell"
# HuggingFace moved from api-inference.huggingface.co (410 Gone) to router.huggingface.co
HF_INFERENCE_URL = f"https://router.huggingface.co/hf-inference/models/{HF_IMAGE_MODEL}"

POLLINATIONS_API_KEY = os.getenv("POLLINATIONS_API_KEY", "")

# ── 可用聲音清單 ─────────────────────────────────────────────
# ★ 標示的聲音使用 zh-CN XiaoxiaoNeural / YunxiNeural / YunyangNeural，
#   是 Microsoft 中文 TTS 品質最高的聲音，語調更自然、更接近真人。
VOICES = [
    # ── 精選高品質（zh-CN，語調最自然） ───────────────────
    {"id": "cn-natural-female",  "label": "自然女聲 ★",  "emoji": "🌟", "group": "精選推薦"},
    {"id": "cn-natural-male",    "label": "自然男聲 ★",  "emoji": "⭐", "group": "精選推薦"},
    {"id": "cn-story-male",      "label": "說書聲音 ★",  "emoji": "📻", "group": "精選推薦"},
    # ── 孩童聲（zh-CN，真實兒童感） ────────────────────────
    {"id": "cn-child-girl",      "label": "活潑小女孩",  "emoji": "👧", "group": "孩童聲音"},
    {"id": "cn-girl-clear",      "label": "清亮女孩",    "emoji": "🎀", "group": "孩童聲音"},
    {"id": "cute_boy",           "label": "可愛男孩",    "emoji": "🐣", "group": "孩童聲音"},
    # ── 女聲 ───────────────────────────────────────────────
    {"id": "cn-girl-soft",       "label": "成熟女聲",    "emoji": "👩‍💼", "group": "女聲"},
    {"id": "female-yujie",       "label": "御姐音",      "emoji": "👩",  "group": "女聲"},
    {"id": "audiobook_female_2", "label": "說書女聲",    "emoji": "📚",  "group": "女聲"},
    {"id": "elderly_woman",      "label": "老奶奶音",    "emoji": "👵",  "group": "女聲"},
    # ── 男聲 ───────────────────────────────────────────────
    {"id": "male-qn-qingse",     "label": "青澀男聲",    "emoji": "👦",  "group": "男聲"},
    {"id": "male-qn-jingying",   "label": "精英男聲",    "emoji": "🧑‍💼", "group": "男聲"},
    {"id": "male-qn-badao",      "label": "霸道男聲",    "emoji": "👨",  "group": "男聲"},
    {"id": "presenter_male",     "label": "播報男聲",    "emoji": "🎙️", "group": "男聲"},
    {"id": "audiobook_male_2",   "label": "說書男聲",    "emoji": "📖",  "group": "男聲"},
    {"id": "elderly_man",        "label": "老爺爺音",    "emoji": "👴",  "group": "男聲"},
]

VALID_VOICE_IDS = {v["id"] for v in VOICES}
VALID_EMOTIONS: frozenset[str] = frozenset(
    {"happy", "sad", "angry", "surprised", "fearful", "disgusted", "neutral"}
)

# MiniMax voice ID → Groq Orpheus voice
VOICE_TO_GROQ = {
    "cn-natural-female":      "diana",
    "cn-natural-male":        "daniel",
    "cn-story-male":          "troy",
    "cn-child-girl":          "autumn",
    "cn-girl-clear":          "autumn",
    "cn-girl-soft":           "autumn",
    "female-yujie":           "diana",
    "male-qn-qingse":         "austin",
    "male-qn-jingying":       "daniel",
    "male-qn-badao":          "troy",
    "presenter_male":         "daniel",
    "audiobook_male_2":       "troy",
    "audiobook_female_2":     "hannah",
    "cute_boy":               "austin",
    "elderly_man":            "troy",
    "elderly_woman":          "hannah",
}

# MiniMax voice ID → Microsoft Edge TTS voice
VOICE_TO_EDGE = {
    # ── 高品質 zh-CN 聲音 ──────────────────────────────────
    "cn-natural-female":      "zh-CN-XiaoxiaoNeural",   # 最自然女聲
    "cn-natural-male":        "zh-CN-YunxiNeural",      # 最自然男聲
    "cn-story-male":          "zh-CN-YunyangNeural",    # 新聞/說書男聲
    "cn-child-girl":          "zh-CN-XiaoyiNeural",     # 活潑小女孩（孩童感最強）
    "cn-girl-clear":          "zh-CN-YunxiaNeural",     # 清亮女孩
    "cn-girl-soft":           "zh-CN-XiaoxiaoNeural",   # 柔和女孩（語速稍慢、音調偏低）
    # ── 台灣腔 zh-TW ───────────────────────────────────────
    "female-yujie":           "zh-TW-HsiaoChenNeural", # 御姐音
    "male-qn-qingse":         "zh-TW-YunJheNeural",    # 青澀男聲
    "male-qn-jingying":       "zh-TW-YunJheNeural",    # 精英男聲
    "male-qn-badao":          "zh-TW-YunJheNeural",    # 霸道男聲
    "presenter_male":         "zh-TW-YunJheNeural",    # 播報男聲
    "audiobook_male_2":       "zh-TW-YunJheNeural",    # 說書男聲
    "audiobook_female_2":     "zh-TW-HsiaoChenNeural", # 說書女聲
    "cute_boy":               "zh-TW-HsiaoYuNeural",   # 可愛男孩
    "elderly_man":            "zh-TW-YunJheNeural",    # 老爺爺音
    "elderly_woman":          "zh-TW-HsiaoChenNeural", # 老奶奶音
}

# ── 科大訊飛 voice ID 映射 ────────────────────────────────────
# 免費基礎聲音：xiaoyan / xiaoyu（所有帳號可用）
# 精選聲音（aisjiajia / aisxiaofeng）需在開放平台控制台開通
VOICE_TO_XFYUN: dict[str, str] = {
    "cn-natural-female":      "aisjiajia",    # ★ 嘉嘉 — 溫柔自然，品質最佳
    "cn-natural-male":        "aisxiaofeng",  # ★ 小風 — 標準自然男聲
    "cn-story-male":          "aisjinger",    # ★ 靜兒 → 備選；若未開通自動降回 xiaoyu
    "cn-child-girl":          "xiaoyan",      # 小燕 — 孩童備用
    "cn-girl-clear":          "xiaoyan",
    "cn-girl-soft":           "xiaoyan",
    "female-yujie":           "xiaoyan",
    "male-qn-qingse":         "xiaoyu",       # 小宇 — 年輕男聲（免費）
    "male-qn-jingying":       "xiaoyu",
    "male-qn-badao":          "xiaoyu",
    "presenter_male":         "xiaoyu",
    "audiobook_male_2":       "xiaoyu",
    "audiobook_female_2":     "xiaoyan",
    "cute_boy":               "xiaoyu",
    "elderly_man":            "xiaoyu",
    "elderly_woman":          "xiaoyan",
}

# Dialogue line-length rules, keyed by the `line_length` request field.
# Defined at module level so the dict is allocated once, not on every request.
_LINE_LENGTH_RULES = {
    "short":    "- 台詞不超過 12 字/句，用詞要非常簡單，讓幼兒也能聽懂",
    "standard": "- 台詞不超過 20 字/句",
    "long":     "- 台詞可長達 35 字/句，可使用較豐富的描述與詞彙",
}

# Dialogue line-count rules, keyed by the `line_count` request field.
# Controls total number of lines generated per scene; each character still speaks ≥1 line.
_LINE_COUNT_RULES = {
    "few":      "- 全幕台詞總數控制在 3～5 句（精簡節奏，適合輕快或收尾幕次）",
    "standard": "- 全幕台詞總數控制在 6～9 句（標準節奏）",
    "many":     "- 全幕台詞總數控制在 10～14 句（豐富對白，適合高潮或情感濃烈的幕次）",
}

# Vocabulary and tone rules by target reader age group.
# Each value is injected as an extra bullet into the generate-script prompt.
_AGE_GROUP_RULES: dict[str, str] = {
    "toddler": (
        "- 【幼兒版 3～6 歲】用語極度簡單，多用重複句型（如：「我要、我要！」）、"
        "擬聲詞（如：哇哦、咚咚、啪啦），句子短且節奏明快，避免抽象概念與長複句，"
        "讓孩子聽一遍就能跟著說"
    ),
    "child": (
        "- 【兒童版 7～10 歲】用語清楚易懂，詞彙中等，可有簡單的情節轉折與道德啟示，"
        "句子流暢自然，鼓勵共情與解決問題的思維"
    ),
    "preteen": (
        "- 【少年版 11～14 歲】可使用較豐富的詞彙與比喻，劇情可有反轉或哲理思考，"
        "對話可展現更複雜的情感衝突，語言接近青少年日常對話風格"
    ),
}

# Maps Chinese art-style names (sent from the frontend) to English equivalents
# used inside the English scene_prompt instruction sent to image generation APIs.
_IMAGE_STYLE_EN: dict[str, str] = {
    "水彩繪本": "watercolor children's book illustration",
    "粉彩卡通": "pastel cartoon illustration",
    "鉛筆素描": "pencil sketch illustration",
    "宮崎駿風": "Studio Ghibli inspired anime style",
    "3D 卡通":  "3D cartoon animation style",
}

# Fallback English visual hints keyed by emoji.
# Used when a character has no explicit visual_description so that the FLUX
# image prompt still contains concrete appearance details.
_EMOJI_VISUAL_HINTS: dict[str, str] = {
    "🐰": "a cute small white bunny with long floppy ears",
    "🦊": "an orange fox with a bushy tail and bright eyes",
    "🐻": "a friendly brown bear with a round belly",
    "🐼": "a chubby black and white panda bear",
    "🦁": "a majestic lion with a golden mane",
    "🐸": "a small bright green frog with big round eyes",
    "🦄": "a white unicorn with a colorful rainbow horn and flowing mane",
    "🐧": "a small tuxedo black and white penguin",
    "🐶": "a fluffy puppy with floppy ears and a wagging tail",
    "🐱": "a small cat with soft fur, big eyes, and tiny whiskers",
    "🐮": "a white cow with black spots and gentle eyes",
    "🐷": "a plump pink pig with a curly tail and snout",
    "🐭": "a tiny gray mouse with large round ears",
    "🐹": "a chubby golden hamster with pouchy cheeks",
    "🐨": "a soft gray koala with large rounded ears",
    "🦝": "a raccoon with a striped bushy tail and black eye mask",
    "🦔": "a small brown hedgehog covered in soft spines",
    "🐺": "a gray wolf with sharp amber eyes and pointed ears",
    "🦅": "a majestic eagle with brown feathers and a sharp curved beak",
    "🐢": "a small green turtle with a patterned brown shell",
    "🦋": "a colorful butterfly with delicate patterned wings",
    "🐬": "a sleek blue-gray dolphin with a friendly smile",
    "🐘": "a large gray elephant with big fan ears and a long trunk",
    "🦒": "a tall spotted giraffe with an extra-long neck and orange patches",
    "🦓": "a zebra with bold black and white stripes",
    "🐉": "a small friendly dragon with green scales, small wings, and big eyes",
    "👦": "a young boy with short dark hair wearing a casual striped shirt",
    "👧": "a young girl with twin pigtails wearing a cheerful colorful dress",
    "🧒": "a small child with a round cheerful face and bright curious eyes",
    "👨": "a young man with short neat hair and a friendly smile",
    "👩": "a young woman with shoulder-length hair and kind expressive eyes",
    "🧑": "a teenager with a cheerful open expression",
    "👴": "a kind elderly man with white hair, rosy cheeks, and a warm smile",
    "👵": "a gentle elderly woman with silver hair and twinkling eyes",
    "🧓": "a middle-aged person with silver-streaked hair and warm expression",
    "🧙": "a wizard in a midnight-blue star-patterned robe and tall pointed hat",
    "🧝": "an elf with pointy ears, almond eyes, and leafy green clothing",
    "🧚": "a tiny fairy with shimmering dragonfly wings and a glowing wand",
    "🧜": "a mermaid with a shimmering iridescent fish tail and flowing hair",
    "🧞": "a large magical genie with glowing blue skin and billowing robes",
    "🦸": "a superhero in a bright-colored cape and a bold mask",
    "🦹": "a villain in a dramatic dark costume with a mysterious air",
    "🧸": "a soft plush teddy bear with round button eyes and a stitched smile",
    "👾": "a cute pixel-art space alien with big cartoon eyes",
    "🤖": "a friendly rounded silver robot with glowing blue eye panels",
    "👻": "a cute translucent white ghost with a cheerful goofy expression",
    "🎃": "a glowing jack-o-lantern with a carved smile and orange glow",
    "🏰": "a fairy-tale stone castle with tall towers and fluttering pennants",
    # ── Human roles (selectable in CharacterPanel but previously missing) ──
    "👨‍🍳": "a cheerful male chef in a white double-breasted jacket and tall toque blanche, warm smile",
    "👩‍🍳": "a cheerful female chef in a white apron and tall toque blanche, bright kind eyes",
    "🕵️": "a sharp-eyed detective in a long trench coat and brimmed fedora, holding a magnifying glass",
    # ── Magical / fantasy objects used as characters ──
    "🪄":  "a sentient magic wand with a glowing star tip and sparkles trailing from its polished handle",
    "⭐":  "a small golden five-pointed star character with a cheerful glowing face and twinkling rays",
    "🌟":  "a radiant golden star spirit with sparkling light rays and a serene smiling face",
    "🌈":  "a rainbow-colored wisp spirit with arching stripes of light and a joyful floating form",
    "☁️":  "a fluffy white cloud character with a soft rounded shape, gentle smiling face, and wispy edges",
    "🔮":  "a mysterious crystal ball with swirling violet mist inside, glowing with inner magical light",
    "💎":  "a sparkling blue diamond gem character with gleaming faceted edges and a radiant inner glow",
}


def _xfyun_auth_url() -> str:
    """Build HMAC-SHA256 signed WebSocket URL for iFlytek TTS API."""
    host = "tts-api.xfyun.cn"
    path = "/v2/tts"
    date = email.utils.formatdate(usegmt=True)   # RFC 1123, e.g. "Mon, 01 Jan 2024 00:00:00 GMT"
    signature_origin = f"host: {host}\ndate: {date}\nGET {path} HTTP/1.1"
    signature = base64.b64encode(
        hmac.new(XFYUN_API_SECRET.encode(), signature_origin.encode(), hashlib.sha256).digest()
    ).decode()
    authorization_origin = (
        f'api_key="{XFYUN_API_KEY}",algorithm="hmac-sha256",'
        f'headers="host date request-line",signature="{signature}"'
    )
    authorization = base64.b64encode(authorization_origin.encode()).decode()
    params = urllib.parse.urlencode({"authorization": authorization, "date": date, "host": host})
    return f"wss://{host}{path}?{params}"


def _pct_to_xfyun(pct_str: str, default: int = 50) -> int:
    """Convert '+8%' / '-15%' to iFlytek 0-100 scale (50 = normal)."""
    try:
        val = int(pct_str.strip().rstrip("%"))
        return max(0, min(100, 50 + val // 2))
    except (ValueError, AttributeError):
        return default


async def _generate_voice_xfyun(text: str, voice_id: str, emotion: Optional[str]) -> bytes:
    """Synthesise speech via iFlytek WebSocket TTS. Returns raw MP3 bytes.

    Raises RuntimeError if websockets library is not installed or API fails.
    The caller should catch and fall back to Edge TTS.
    """
    try:
        import websockets as _ws   # optional dep; installed in requirements.txt
    except ImportError:
        raise RuntimeError("websockets 未安裝")

    vcn = VOICE_TO_XFYUN.get(voice_id, "xiaoyan")
    p   = _EMOTION_PROSODY.get(emotion or "neutral", {"rate": "+0%", "volume": "+0%"})
    spd = _pct_to_xfyun(p.get("rate",   "+0%"))
    vol = _pct_to_xfyun(p.get("volume", "+0%"))

    url = _xfyun_auth_url()

    async def _do_ws() -> bytes:
        audio_chunks: list[bytes] = []
        async with _ws.connect(url) as ws:
            await ws.send(json.dumps({
                "common":   {"app_id": XFYUN_APP_ID},
                "business": {
                    "aue": "lame",   # MP3
                    "sfl": 1,        # 流式合成
                    "tte": "utf8",
                    "vcn": vcn,
                    "spd": spd,
                    "vol": vol,
                },
                "data": {
                    "status": 2,     # 2 = complete single-shot request
                    "text": base64.b64encode(text.encode("utf-8")).decode(),
                },
            }))

            async for message in ws:
                resp = json.loads(message)
                code = resp.get("code", -1)
                if code != 0:
                    raise RuntimeError(f"iFlytek error {code}: {resp.get('message', '')}")
                d = resp.get("data", {})
                if d.get("audio"):
                    audio_chunks.append(base64.b64decode(d["audio"]))
                if d.get("status") == 2:   # 2 = last frame
                    break
        return b"".join(audio_chunks)

    # Guard against a hanging iFlytek connection — without this, a slow or
    # unresponsive server would hold the async worker indefinitely, starving
    # other concurrent voice-generation requests.
    try:
        return await asyncio.wait_for(_do_ws(), timeout=30)
    except asyncio.TimeoutError:
        raise RuntimeError("iFlytek TTS timeout (30 s)")


# ── Models ───────────────────────────────────────────────────
class Character(BaseModel):
    id: str = Field(..., max_length=64)
    name: str = Field(..., min_length=1, max_length=30)
    personality: str = Field(..., max_length=100)
    visual_description: Optional[str] = Field(None, max_length=200)
    voice_id: str = Field(..., max_length=64)
    color: str = Field(..., max_length=20)
    emoji: str = Field(..., max_length=10)
    # Optional AI-generated character portrait (data URI); not validated for length
    # because it can be a full-size base64 image (~50-150 kB).
    portrait_url: Optional[str] = None

    @field_validator("name", mode="before")
    @classmethod
    def name_not_blank(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip()
        if not v:
            raise ValueError("角色名稱不能為空白")
        return v

    @field_validator("voice_id")
    @classmethod
    def voice_must_be_valid(cls, v: str) -> str:
        if v not in VALID_VOICE_IDS:
            raise ValueError("無效的 voice_id")
        return v

class GenerateScriptRequest(BaseModel):
    scene_description: str = Field(..., min_length=1, max_length=500)
    characters: Annotated[List[Character], Field(min_length=1, max_length=6)]
    style: Optional[str] = Field("溫馨童趣", max_length=20)
    story_context: Optional[str] = Field(None, max_length=5000)
    line_length: Optional[str] = Field("standard", max_length=20)  # 'short' | 'standard' | 'long'
    line_count: Optional[str] = Field("standard", max_length=20)   # 'few' | 'standard' | 'many'
    is_ending: Optional[bool] = False  # True → inject ending guidance into prompt
    image_style: Optional[str] = Field("watercolor children's book illustration", max_length=80)
    mood: Optional[str] = Field(None, max_length=20)  # e.g. 輕鬆愉快|溫馨感動|緊張刺激|搞笑幽默|神奇夢幻
    age_group: Optional[str] = Field(None, max_length=20)  # 'toddler' | 'child' | 'preteen'

    @field_validator("scene_description", mode="before")
    @classmethod
    def description_not_blank(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip()
        if not v:
            raise ValueError("場景描述不能為空白")
        return v

class GenerateLine(BaseModel):
    character_id: str
    voice_id: str
    text: str

class GenerateVoiceRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200)
    voice_id: str = Field(..., max_length=64)
    emotion: Optional[str] = Field(None, max_length=20)

    @field_validator("text", mode="before")
    @classmethod
    def text_not_blank(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip()
        if not v:
            raise ValueError("語音文字不能為空白")
        return v

    @field_validator("voice_id")
    @classmethod
    def voice_must_be_valid(cls, v: str) -> str:
        if v not in VALID_VOICE_IDS:
            raise ValueError("無效的 voice_id")
        return v

    @field_validator("emotion", mode="before")
    @classmethod
    def emotion_must_be_valid(cls, v: object) -> Optional[str]:
        if v is None:
            return None
        s = str(v).strip().lower()
        if not s:
            return None
        if s not in VALID_EMOTIONS:
            raise ValueError(f"無效的情緒值：{v!r}，允許值：{sorted(VALID_EMOTIONS)}")
        return s

class GenerateImageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=1000)
    # Stable seed derived from the project's character set + image style.
    # Reusing the same seed across scenes makes FLUX generate visually
    # consistent character appearances and lighting throughout the book.
    seed: Optional[int] = Field(None, ge=1, le=2147483647)

    @field_validator("prompt", mode="before")
    @classmethod
    def prompt_not_blank(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip()
        if not v:
            raise ValueError("圖片提示詞不能為空白")
        return v

class ScriptLine(BaseModel):
    character_name: str
    character_id: str
    voice_id: str
    text: str
    emotion: Optional[str] = "neutral"

class ScriptResponse(BaseModel):
    lines: List[ScriptLine]
    scene_prompt: str = ""
    sfx_description: str = ""
    scene_title: str = ""   # Auto-generated short scene title (4-8 Chinese chars)

# ── 端點：取得聲音清單 ────────────────────────────────────────
@app.get("/api/voices")
def get_voices():
    # VOICES is a static list that never changes at runtime; allow browsers and
    # CDN edges to cache the response for 24 hours to reduce unnecessary round trips.
    return JSONResponse(content=VOICES, headers={"Cache-Control": "public, max-age=86400"})

# ── 語音生成 LRU 快取（記憶體，最多 200 筆，避免重複合成相同台詞）──────
_TTS_CACHE_MAX = 200
# Key is a (voice_id, emotion, text) tuple rather than a colon-joined string.
# Using a tuple avoids false cache hits when `text` contains ":" (e.g. "小兔：早安"),
# which would make the string-concatenated key indistinguishable from a request
# with a different (voice_id, emotion) split at the same position.
_CacheKey = tuple  # (voice_id: str, emotion: str, text: str)
_tts_cache: "OrderedDict[_CacheKey, tuple[bytes, str]]" = OrderedDict()  # key → (audio_bytes, fmt)

def _tts_cache_get(key: _CacheKey) -> "tuple[bytes, str] | None":
    if key not in _tts_cache:
        return None
    _tts_cache.move_to_end(key)          # LRU: refresh access order
    return _tts_cache[key]

def _tts_cache_put(key: _CacheKey, audio_bytes: bytes, fmt: str) -> None:
    if key in _tts_cache:
        _tts_cache.move_to_end(key)
    _tts_cache[key] = (audio_bytes, fmt)
    while len(_tts_cache) > _TTS_CACHE_MAX:
        _tts_cache.popitem(last=False)   # evict least-recently-used

# ── 聲音試聽快取（記憶體，每個 voice 只合成一次）──────────────
_voice_preview_cache: dict[str, bytes] = {}

# 每種聲音類型對應的試聽範例句
_VOICE_SAMPLE: dict[str, str] = {
    "cn-natural-female":      "嗨！大家好，我是你的故事角色，很高興認識你喔！今天我們要一起去冒險了！",
    "cn-natural-male":        "大家好，今天的故事就從這裡開始。準備好了嗎？讓我們一起出發吧！",
    "cn-story-male":          "話說從前，在一座茂密的大森林裡，住著一群快樂的小動物……",
    "cn-child-girl":          "哇！那個好漂亮喔！我們去那裡玩好不好？耶耶耶！",
    "cn-girl-clear":          "嗯嗯！我知道了，媽媽說要勇敢，我才不怕呢！",
    "cn-girl-soft":           "我想要一隻小兔子……軟軟的、毛茸茸的那種。",
    "female-yujie":           "嗯，這個故事才剛開始，有趣的事還在後頭呢。",
    "male-qn-qingse":         "呃……我有點緊張，不過我會努力的！",
    "male-qn-jingying":       "很好，一切都在掌握之中，讓我們繼續前進。",
    "male-qn-badao":          "哼，這點小事難不倒我，跟我走就對了！",
    "presenter_male":         "各位朋友，歡迎收聽今天的精彩故事。",
    "audiobook_male_2":       "話說在很久很久以前，有一個神奇的地方……",
    "audiobook_female_2":     "從前從前，在一座美麗的森林裡，住著一群可愛的動物。",
    "cute_boy":               "哇！好好玩喔！我要去探險了，耶！",
    "elderly_man":            "孩子啊，來，爺爺說個故事給你聽。",
    "elderly_woman":          "來來來，乖孫子，奶奶今天要說一個很特別的故事。",
}

@app.get("/api/voices/{voice_id}/preview")
async def voice_preview(
    voice_id: str,
    request: Request,
    response: Response,
    text: Optional[str] = Query(None, max_length=200),
):
    ip = _client_ip(request)
    if not _rl_voice.is_allowed(ip):
        raise _rl_429(_rl_voice, ip)
    if voice_id not in VALID_VOICE_IDS:
        raise HTTPException(status_code=404, detail="找不到此聲音")

    # Custom text: synthesise on demand and skip the cache entirely
    # (cache key is voice_id only; custom-text results must not pollute it)
    custom_text = text.strip() if text and text.strip() else None

    # Voice previews are deterministic — let the browser cache them for 1 hour.
    # Each unique ?text= gets its own cache entry (URL-based key).
    response.headers["Cache-Control"] = "public, max-age=3600"

    if not custom_text and voice_id in _voice_preview_cache:
        cached = _voice_preview_cache[voice_id]
        return {"audio_base64": base64.b64encode(cached).decode(), "format": "mp3"}

    sample_text = custom_text or _VOICE_SAMPLE.get(voice_id, "大家好！我是故事裡的角色，很高興認識你。")

    # ── 1. 科大訊飛（與主要 TTS 端點一致，若已設定優先使用）────────
    if XFYUN_APP_ID and XFYUN_API_KEY and XFYUN_API_SECRET:
        try:
            audio = await _generate_voice_xfyun(sample_text, voice_id, "happy")
            if audio:
                if not custom_text:
                    _voice_preview_cache[voice_id] = audio
                return {"audio_base64": base64.b64encode(audio).decode(), "format": "mp3"}
            logger.warning("iFlytek preview returned empty audio for %s", voice_id)
        except Exception as e:
            logger.warning("iFlytek preview failed for %s: %s — falling back to Edge TTS", voice_id, e)

    # ── 2. Microsoft Edge TTS（備用）──────────────────────────────
    edge_voice = VOICE_TO_EDGE.get(voice_id, "zh-TW-HsiaoYuNeural")
    prosody = _emotion_prosody_params("happy", voice_id)
    try:
        communicate = edge_tts.Communicate(
            text=_prepare_tts_text(sample_text),
            voice=edge_voice,
            rate=prosody["rate"],
            volume=prosody["volume"],
            pitch=prosody["pitch"],
        )
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        audio = buf.getvalue()
        if not audio:
            raise ValueError("empty audio")
        if not custom_text:
            _voice_preview_cache[voice_id] = audio
        return {"audio_base64": base64.b64encode(audio).decode(), "format": "mp3"}
    except Exception as e:
        logger.warning("Voice preview failed for %s: %s", voice_id, e)
        raise HTTPException(status_code=502, detail="試聽生成失敗")

# ── 端點：自動生成書名 ────────────────────────────────────────
class GenerateTitleRequest(BaseModel):
    characters: Annotated[List[Character], Field(min_length=1, max_length=6)]
    scene_description: str = Field(..., max_length=500)
    first_lines: List[str] = Field(default_factory=list, max_length=20)

@app.post("/api/generate-title")
async def generate_title(req: GenerateTitleRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_title.is_allowed(ip):
        raise _rl_429(_rl_title, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")
    char_names = "、".join(c.name for c in req.characters)
    lines_preview = " ".join(req.first_lines[:5])
    prompt = f"""你是台灣繪本作家。根據以下資訊，為這本繪本取一個有創意的書名。

角色：{char_names}
場景：{req.scene_description}
對話片段：{lines_preview}

要求：
- 使用台灣繁體中文
- 書名 4～12 個字，簡短吸引人
- 風格溫馨、適合兒童
- 只回傳書名文字，不要任何說明或標點符號"""

    def _clean_title(raw: str) -> str:
        t = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        if not t:
            # search inside think block as fallback
            m = re.search(r'[\u4e00-\u9fff]{4,12}', raw)
            t = m.group(0) if m else ""
        t = t.strip('「」『』""\'').strip()
        # Return empty string for invalid lengths so _llm_single_string retries the next model
        return t if 1 <= len(t) <= 20 else ""

    title = await _llm_single_string(
        prompt, _clean_title,
        temperature=0.9, max_tokens=30,
        log_tag="generate-title", error_detail="書名生成失敗",
    )
    return {"title": title}


# ── Shared LLM helper: single-prompt → single-string (Groq → MiniMax) ────
async def _llm_single_string(
    prompt: str,
    clean_fn,
    *,
    temperature: float = 0.7,
    max_tokens: int = 100,
    log_tag: str = "llm",
    error_detail: str = "生成失敗",
    groq_model: str = GROQ_FAST_MODEL,
) -> str:
    """Call Groq first, fall back to MiniMax; return the cleaned result or raise HTTP 502.

    ``groq_model`` defaults to GROQ_FAST_MODEL (8B) which is sufficient for the short
    outputs this helper produces (titles, personality blurbs, visual descriptions).
    Pass GROQ_QUALITY_MODEL explicitly for tasks that benefit from richer reasoning.
    """
    if GROQ_API_KEY:
        try:
            resp = await _http_client.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": groq_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=20,
            )
            resp.raise_for_status()
            result = clean_fn(resp.json()["choices"][0]["message"].get("content", ""))
            if result:
                logger.info("%s via Groq: %s", log_tag, result[:80])
                return result
        except Exception as e:
            logger.warning("%s Groq failed: %s", log_tag, e)

    if MINIMAX_API_KEY:
        try:
            resp = await _http_client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=30,
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"].get("content", "")
            if isinstance(raw, list):
                raw = " ".join(b.get("text", "") for b in raw if b.get("type") == "text")
            result = clean_fn(str(raw))
            if result:
                logger.info("%s via MiniMax: %s", log_tag, result[:80])
                return result
        except Exception as e:
            logger.warning("%s MiniMax failed: %s", log_tag, e)

    raise HTTPException(status_code=502, detail=error_detail)


# ── 端點：AI 角色外形描述生成 ─────────────────────────────────
class SuggestVisualRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=30)
    personality: str = Field("", max_length=100)
    emoji: str = Field("", max_length=10)
    style: str = Field("溫馨童趣", max_length=20)


@app.post("/api/suggest-visual-description")
async def suggest_visual_description(req: SuggestVisualRequest, request: Request):
    """Generate an English visual description for a character suitable for image generation."""
    ip = _client_ip(request)
    if not _rl_suggest_char.is_allowed(ip):
        raise _rl_429(_rl_suggest_char, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    prompt = (
        f"Generate a concise English visual description for a children's picture book character.\n\n"
        f"Character name: {req.name} {req.emoji}\n"
        f"Personality: {req.personality or 'friendly'}\n"
        f"Story style: {req.style}\n\n"
        "Write ONE sentence (15-40 words) describing only the character's appearance: "
        "species/type, physical features, clothing, and color scheme. "
        "Keep it vivid, specific, and suitable for an AI image generator. "
        "Output the description only, no quotes, no extra text."
    )

    def _clean(raw: str) -> str:
        cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        return cleaned.strip("\"'")[:200]

    desc = await _llm_single_string(
        prompt, _clean, temperature=0.7, max_tokens=100,
        log_tag="suggest-visual", error_detail="外形描述生成失敗",
    )
    return {"description": desc}


# ── 端點：AI 故事摘要生成 ──────────────────────────────────────
class GenerateSummaryRequest(BaseModel):
    characters: Annotated[List[Character], Field(min_length=1, max_length=10)]
    story_context: str = Field(..., max_length=5000)


@app.post("/api/generate-summary")
async def generate_summary(req: GenerateSummaryRequest, request: Request):
    """Generate a 2–3 sentence summary of the entire story."""
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    char_names = "、".join(c.name for c in req.characters[:8])
    prompt = (
        "你是台灣繪本作家。請根據以下故事內容，用2到3句繁體中文寫出這個繪本故事的精彩摘要（100字以內）。"
        "語氣輕鬆溫馨，適合介紹給家長或讀者。只回傳摘要文字，不要任何說明或前言。\n\n"
        f"主角：{char_names}\n"
        f"故事內容：\n{req.story_context}"
    )

    def _clean(raw: str) -> str:
        return re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()

    summary = await _llm_single_string(
        prompt, _clean, temperature=0.5, max_tokens=200,
        log_tag="generate-summary", error_detail="摘要生成失敗",
        groq_model=GROQ_QUALITY_MODEL,  # summary needs richer reasoning for coherent Chinese prose
    )
    return {"summary": summary[:300]}


# ── 端點：AI 角色個性描述生成 ─────────────────────────────────
class SuggestPersonalityRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=30)
    emoji: str = Field("", max_length=10)
    style: str = Field("溫馨童趣", max_length=20)


@app.post("/api/suggest-personality")
async def suggest_personality(req: SuggestPersonalityRequest, request: Request):
    """Generate a Chinese personality description for a character."""
    ip = _client_ip(request)
    if not _rl_suggest_char.is_allowed(ip):
        raise _rl_429(_rl_suggest_char, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    prompt = (
        f"你是台灣兒童繪本作家。為以下角色設計一段個性描述（繁體中文）。\n\n"
        f"角色名稱：{req.name} {req.emoji}\n"
        f"故事風格：{req.style}\n\n"
        "請寫出這個角色的個性特質，10-30 字，生動有趣，適合兒童繪本。"
        "只輸出個性描述，不要任何多餘文字、標點符號結尾或引號。"
    )

    def _clean(raw: str) -> str:
        cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        return cleaned.strip("\"'。").strip()[:100]

    personality = await _llm_single_string(
        prompt, _clean, temperature=0.8, max_tokens=80,
        log_tag="suggest-personality", error_detail="個性描述生成失敗",
    )
    return {"personality": personality}


# ── 端點：下一幕靈感建議 ──────────────────────────────────────
class SuggestNextSceneRequest(BaseModel):
    characters: Annotated[List[Character], Field(min_length=1, max_length=6)]
    story_context: Optional[str] = Field(None, max_length=5000)  # None = first scene
    style: Optional[str] = Field("溫馨童趣", max_length=20)


class GenerateOutlineRequest(BaseModel):
    characters: Annotated[List[Character], Field(min_length=1, max_length=6)]
    theme: str = Field(..., min_length=1, max_length=200)
    style: str = Field("溫馨童趣", max_length=20)
    scene_count: int = Field(5, ge=3, le=7)

    @field_validator("theme", mode="before")
    @classmethod
    def strip_theme(cls, v: str) -> str:
        return v.strip() if isinstance(v, str) else v

def _is_chinese_text(s: str) -> bool:
    """Return True if the string is predominantly Chinese (>40% CJK characters)."""
    if not s:
        return False
    cjk = sum(1 for c in s if '\u4e00' <= c <= '\u9fff')
    return cjk / len(s) >= 0.4

def _parse_suggestions(raw: str) -> list[str]:
    """Extract 3 Chinese scene suggestions from a raw LLM response string."""
    # Strip think blocks (MiniMax-M2.7 wraps output in <think>)
    stripped = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    # If stripping left nothing, the real answer is INSIDE the think block — search there
    search_text = stripped if stripped else raw

    suggestions: list[str] = []

    # 1. Find ALL JSON objects containing "suggestions" key; take the last one
    #    (models often put final answer at end of think block)
    all_json = re.findall(r'\{[^{}]*"suggestions"[^{}]*\}', search_text, re.DOTALL)
    for candidate in reversed(all_json):
        try:
            data = json.loads(candidate)
            items = [s.strip() for s in data.get("suggestions", []) if isinstance(s, str) and s.strip()]
            items = [s for s in items if _is_chinese_text(s)]
            if items:
                suggestions = items
                break
        except json.JSONDecodeError:
            pass

    # 2. Numbered / bulleted lines — only accept Chinese-heavy lines
    if not suggestions:
        lines = re.findall(r'(?:^|\n)\s*(?:\d+[.、。）)]\s*)(.{10,80})', search_text)
        suggestions = [l.strip().strip('「」') for l in lines if _is_chinese_text(l.strip())]

    # 3. Last-resort: split on sentence endings / newlines
    if not suggestions:
        chunks = re.split(r'[。！\n]{1,2}', search_text)
        suggestions = [c.strip() for c in chunks if len(c.strip()) >= 10 and _is_chinese_text(c.strip())][:3]

    return suggestions[:3]


async def _llm_suggestions(
    prompt: str,
    *,
    temperature: float = 0.9,
    max_tokens: int = 250,
    groq_timeout: float = 20,
    minimax_timeout: float = 30,
    endpoint_name: str = "llm",
) -> list[str]:
    """Call Groq then MiniMax (fallback); parse and return suggestion list.

    Returns an empty list if both providers fail (caller decides error handling).
    """
    last_error: Exception | None = None

    if GROQ_API_KEY:
        try:
            resp = await _http_client.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": GROQ_QUALITY_MODEL,  # suggestions need richer creative reasoning
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=groq_timeout,
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"].get("content", "")
            suggestions = _parse_suggestions(str(raw))
            if suggestions:
                logger.info("%s via Groq: %s", endpoint_name, suggestions)
                return suggestions
        except Exception as e:
            logger.warning("%s Groq failed: %s", endpoint_name, e)
            last_error = e

    if MINIMAX_API_KEY:
        try:
            resp = await _http_client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "max_tokens": max_tokens,
                },
                timeout=minimax_timeout,
            )
            resp.raise_for_status()
            raw_content = resp.json()["choices"][0]["message"].get("content", "")
            if isinstance(raw_content, list):
                raw_content = " ".join(b.get("text", "") for b in raw_content if b.get("type") == "text")
            suggestions = _parse_suggestions(str(raw_content))
            if suggestions:
                logger.info("%s via MiniMax: %s", endpoint_name, suggestions)
                return suggestions
        except Exception as e:
            logger.warning("%s MiniMax failed: %s", endpoint_name, e)
            last_error = e

    logger.warning("%s all providers failed: %s", endpoint_name, last_error)
    return []


@app.post("/api/suggest-next-scene")
async def suggest_next_scene(req: SuggestNextSceneRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")
    char_names = "、".join(c.name for c in req.characters)
    char_desc = "、".join(
        f"{c.name}（{c.personality}）" for c in req.characters
    )

    if req.story_context:
        # Continuation: suggest what happens next
        prompt = f"""你是台灣繪本故事作家。根據以下故事脈絡，為下一幕提供 3 個不同方向的場景描述建議。

角色：{char_names}
風格：{req.style}
前情脈絡：
{req.story_context}

請提供 3 個簡短的「下一幕場景描述」，每個約 20-50 字，方向各異（例如：衝突、驚喜、溫馨、冒險等）。

直接輸出 JSON，格式如下，不要任何多餘說明：
{{"suggestions": ["描述1", "描述2", "描述3"]}}

注意：
- 使用台灣繁體中文
- 每個描述要能自然銜接前情
- 簡潔生動，適合兒童繪本"""
    else:
        # First scene: suggest engaging opening scenarios
        prompt = f"""你是台灣繪本故事作家。根據以下角色設定，為繪本的第一幕提供 3 個不同風格的開場場景描述建議。

角色：{char_desc}
故事風格：{req.style}

請提供 3 個有趣的「開場場景描述」，每個約 20-50 字，風格各異（例如：奇幻相遇、日常生活、神秘事件、溫馨出發等），能自然引出角色並展開故事。

直接輸出 JSON，格式如下，不要任何多餘說明：
{{"suggestions": ["描述1", "描述2", "描述3"]}}

注意：
- 使用台灣繁體中文，符合台灣語言習慣
- 每個描述都要包含角色名字
- 簡潔生動，讓兒童一聽就感興趣"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.8,
        max_tokens=400,
        groq_timeout=30,
        minimax_timeout=30,
        endpoint_name="suggest-next-scene",
    )
    if suggestions:
        return {"suggestions": suggestions}
    raise HTTPException(status_code=502, detail="靈感生成失敗")


# ── 端點：故事大綱生成 ────────────────────────────────────────
def _parse_outline(raw: str, expected_count: int) -> list[dict]:
    """Extract outline scenes from LLM response.

    Returns list of {"title": str, "description": str} dicts.
    Tries JSON first, then falls back to numbered line parsing.

    The previous implementation used ``r'\\{[^{}]*"scenes"[^{}]*\\}'`` which
    excluded curly braces inside the pattern, so it could never match the actual
    nested structure ``{"scenes": [{"title": ..., "description": ...}]}``.
    The new implementation mirrors the robust extraction used by generate-script:
    code-fence first → greedy ``{.*}`` / ``[.*]`` with DOTALL → text fallback.
    """
    stripped = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
    search_text = stripped if stripped else raw

    def _extract_scenes(obj: object) -> list[dict]:
        """Pull scene dicts from a parsed JSON value (dict or list)."""
        scenes_raw = obj.get("scenes", []) if isinstance(obj, dict) else obj  # type: ignore[union-attr]
        if not isinstance(scenes_raw, list):
            return []
        scenes: list[dict] = []
        for s in scenes_raw:
            if isinstance(s, dict):
                title = str(s.get("title", "")).strip()
                desc  = str(s.get("description", "")).strip()
                if title and desc:
                    scenes.append({"title": title, "description": desc})
        return scenes

    # 1. Code-fence block — same pattern as generate-script
    code_block = re.search(r"```(?:json)?\s*(\{.*\}|\[.*\])\s*```", search_text, re.DOTALL)
    if code_block:
        try:
            scenes = _extract_scenes(json.loads(code_block.group(1)))
            if len(scenes) >= 2:
                return scenes[:expected_count]
        except (json.JSONDecodeError, TypeError):
            pass

    # 2. Greedy outer-brace match — handles {"scenes": [{...}, ...]} correctly
    #    because .* in DOTALL mode crosses nested { } boundaries.
    obj_match = re.search(r"\{.*\}", search_text, re.DOTALL)
    if obj_match:
        try:
            scenes = _extract_scenes(json.loads(obj_match.group(0)))
            if len(scenes) >= 2:
                return scenes[:expected_count]
        except (json.JSONDecodeError, TypeError):
            pass

    # 3. Greedy outer-bracket match — handles bare [{...}, ...] responses
    arr_match = re.search(r"\[.*\]", search_text, re.DOTALL)
    if arr_match:
        try:
            scenes = _extract_scenes(json.loads(arr_match.group(0)))
            if len(scenes) >= 2:
                return scenes[:expected_count]
        except (json.JSONDecodeError, TypeError):
            pass

    # 4. Fall back: extract numbered sections like "第一幕：\n描述..."
    scenes = []
    blocks = re.split(r'\n(?=第[一二三四五六七]幕|幕次\s*\d)', search_text)
    for block in blocks:
        title_m = re.search(r'[「『【]?([^」』】\n]{2,12})[」』】]?', block[:40])
        desc_m = re.search(r'描述[：:]?\s*(.{10,100})', block)
        if not desc_m:
            lines = [l.strip() for l in block.split('\n') if len(l.strip()) >= 10]
            if len(lines) >= 2:
                desc_m_text = lines[1]
            elif len(lines) == 1:
                desc_m_text = lines[0]
            else:
                continue
        else:
            desc_m_text = desc_m.group(1).strip()
        if title_m and desc_m_text:
            scenes.append({"title": title_m.group(1).strip(), "description": desc_m_text})

    return scenes[:expected_count]


@app.post("/api/generate-outline")
async def generate_outline(req: GenerateOutlineRequest, request: Request):
    """Generate a complete N-scene story outline from a theme + characters."""
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    char_desc = "、".join(f"{c.name}（{c.personality}）" for c in req.characters)
    prompt = f"""你是台灣繪本故事作家。請根據以下設定，為整本繪本規劃 {req.scene_count} 幕的完整故事大綱。

角色：{char_desc}
故事主題或靈感：{req.theme}
故事風格：{req.style}

請提供 {req.scene_count} 幕的大綱，每幕包含「title」（幕次標題，4-8字）和「description」（場景描述，20-50字）。

直接輸出 JSON，格式如下，不要任何多餘說明：
{{"scenes": [{{"title": "幕次標題", "description": "場景描述"}}, ...]}}

注意：
- 使用台灣繁體中文
- 每幕描述要具體生動，包含角色名字和主要動作
- 故事要有起承轉合：第一幕吸引人，中間有衝突或驚喜，最後一幕圓滿收場
- 簡潔易懂，適合兒童繪本"""

    raw_content: str | None = None

    if MINIMAX_API_KEY:
        try:
            resp = await _http_client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.8,
                    "max_tokens": 800,
                },
                timeout=45,
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"].get("content", "")
            if isinstance(content, list):
                content = " ".join(b.get("text", "") for b in content if b.get("type") == "text")
            raw_content = str(content)
            logger.info("generate-outline via MiniMax")
        except Exception as e:
            logger.warning("generate-outline MiniMax failed: %s", e)

    if not raw_content and GROQ_API_KEY:
        try:
            resp = await _http_client.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": GROQ_QUALITY_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.8,
                    "max_tokens": 800,
                },
                timeout=35,
            )
            resp.raise_for_status()
            raw_content = str(resp.json()["choices"][0]["message"].get("content", ""))
            logger.info("generate-outline via Groq fallback")
        except Exception as e:
            logger.warning("generate-outline Groq failed: %s", e)

    if not raw_content:
        raise HTTPException(status_code=502, detail="大綱生成失敗，請重試")

    scenes = _parse_outline(raw_content, req.scene_count)
    if not scenes:
        raise HTTPException(status_code=502, detail="大綱解析失敗，請重試")

    return {"scenes": scenes}


# ── 端點：AI 情感基調建議 ────────────────────────────────────
class SuggestMoodRequest(BaseModel):
    description: Annotated[str, Field(max_length=500)]
    style: Annotated[str, Field(max_length=20)] = "溫馨童趣"
    characters: list[Character] = []


_VALID_MOODS = {"輕鬆愉快", "溫馨感動", "緊張刺激", "搞笑幽默", "神奇夢幻"}


@app.post("/api/suggest-mood")
async def suggest_mood(req: SuggestMoodRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    char_desc = (
        "、".join(f"{c.name}（{c.personality}）" for c in req.characters)
        if req.characters else "（未指定角色）"
    )
    prompt = f"""你是台灣繪本故事作家。根據以下場景描述，從指定情感基調選項中選出最合適的 1 個。

角色：{char_desc}
故事風格：{req.style}
場景描述：{req.description}

可選的情感基調（只能從這些中選一個）：輕鬆愉快、溫馨感動、緊張刺激、搞笑幽默、神奇夢幻

直接輸出 JSON，格式如下，不要任何多餘說明：
{{"suggestions": ["最適合的情感基調"]}}

注意：只輸出一個最適合的選項，且必須與上述選項完全相符。"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.3,
        max_tokens=60,
        groq_timeout=15,
        minimax_timeout=20,
        endpoint_name="suggest-mood",
    )
    suggestions = [s for s in suggestions if s in _VALID_MOODS]
    if suggestions:
        return {"suggestions": suggestions}
    raise HTTPException(status_code=502, detail="情感基調建議生成失敗")


# ── 端點：AI 音效描述建議 ──────────────────────────────────────
class SuggestSfxRequest(BaseModel):
    description: Annotated[str, Field(max_length=500)]
    style: Annotated[str, Field(max_length=20)] = "溫馨童趣"
    lines: list[str] = Field(default_factory=list, max_length=20)

    @field_validator("lines", mode="before")
    @classmethod
    def trim_lines(cls, v: list) -> list:
        return [str(x)[:100] for x in v if x] if isinstance(v, list) else []


@app.post("/api/suggest-sfx")
async def suggest_sfx(req: SuggestSfxRequest, request: Request):
    """AI suggests a background SFX / music description for the scene."""
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    lines_snippet = "、".join(req.lines[:6]) if req.lines else "（無台詞）"
    prompt = f"""你是台灣繪本故事作家。根據以下場景，建議一段簡短的背景音效描述（10～30 字），
描述應讓讀者/聽眾能想像出合適的環境音效或背景音樂。

故事風格：{req.style}
場景描述：{req.description}
場景台詞（節錄）：{lines_snippet}

直接輸出 JSON，格式如下，不要任何多餘說明：
{{"suggestions": ["音效描述文字（中文，10～30字，例如：輕柔鋼琴音樂伴隨森林鳥鳴聲）"]}}"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.6,
        max_tokens=80,
        groq_timeout=15,
        minimax_timeout=20,
        endpoint_name="suggest-sfx",
    )
    if suggestions:
        sfx = suggestions[0].strip()[:100]
        if sfx:
            return {"sfx": sfx}
    raise HTTPException(status_code=502, detail="音效描述建議生成失敗")


# ── 端點：AI 書名建議 ─────────────────────────────────────────
class SuggestTitleRequest(BaseModel):
    story_context: Annotated[str, Field(max_length=5000)]
    style: Annotated[str, Field(max_length=20)] = "溫馨童趣"


@app.post("/api/suggest-title")
async def suggest_title(req: SuggestTitleRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_suggest_scene.is_allowed(ip):
        raise _rl_429(_rl_suggest_scene, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    prompt = f"""你是台灣繪本故事作家。根據以下故事內容，為這本兒童繪本建議 3 個吸引人的書名。

風格：{req.style}
故事內容：
{req.story_context}

請提供 3 個書名，每個 4-15 字，簡短有力、適合兒童繪本、富有想像力。
直接輸出 JSON，格式如下，不要任何多餘說明：
{{"suggestions": ["書名1", "書名2", "書名3"]}}

注意：使用台灣繁體中文"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.9,
        max_tokens=200,
        groq_timeout=30,
        minimax_timeout=30,
        endpoint_name="suggest-title",
    )
    if suggestions:
        return {"suggestions": suggestions}
    raise HTTPException(status_code=502, detail="書名建議生成失敗")


# ── 端點：AI 台詞潤色 ─────────────────────────────────────────
class RephraseLineRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200)
    character_name: str = Field(..., max_length=30)
    personality: str = Field("", max_length=100)
    style: str = Field("溫馨童趣", max_length=20)


@app.post("/api/rephrase-line")
async def rephrase_line(req: RephraseLineRequest, request: Request):
    """Return 3 rephrased alternatives for a single dialogue line."""
    ip = _client_ip(request)
    if not _rl_suggest_line.is_allowed(ip):
        raise _rl_429(_rl_suggest_line, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    personality_note = f"（個性：{req.personality}）" if req.personality else ""
    prompt = f"""你是台灣兒童繪本對話潤色助手。
角色：{req.character_name}{personality_note}
風格：{req.style}

請將以下台詞改寫為 3 個不同版本，保留原意但措辭更生動、自然、符合角色個性。
原台詞：「{req.text}」

要求：
- 使用台灣繁體中文，符合台灣用語
- 每個版本字數不超過原台詞的 1.5 倍，且不超過 40 字
- 適合兒童繪本，口語自然流暢
- 直接輸出 JSON，不要任何說明：
{{"suggestions": ["版本1", "版本2", "版本3"]}}"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.9,
        max_tokens=250,
        groq_timeout=20,
        minimax_timeout=30,
        endpoint_name="rephrase-line",
    )
    if suggestions:
        return {"suggestions": suggestions}
    raise HTTPException(status_code=502, detail="潤色建議生成失敗")


# ── 端點：生成劇本 ────────────────────────────────────────────
class SuggestLineRequest(BaseModel):
    character_name: str = Field(..., max_length=30)
    personality: str = Field("", max_length=100)
    scene_description: str = Field(..., max_length=500)
    style: str = Field("溫馨童趣", max_length=20)
    previous_lines: List[Dict[str, Any]] = Field(default_factory=list, max_length=20)
    line_length: Optional[Literal["short", "standard", "long"]] = "standard"


@app.post("/api/suggest-line")
async def suggest_line(req: SuggestLineRequest, request: Request):
    """Return 3 suggested next lines for a given character in the scene context."""
    ip = _client_ip(request)
    if not _rl_suggest_line.is_allowed(ip):
        raise _rl_429(_rl_suggest_line, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")

    personality_note = f"（個性：{req.personality}）" if req.personality else ""
    prev_context = ""
    if req.previous_lines:
        lines_text = "\n".join(
            f"- {l.get('character_name', '?')}：「{l.get('text', '')}」"
            for l in req.previous_lines[-6:]   # last 6 lines for context
        )
        prev_context = f"\n目前已有台詞：\n{lines_text}"

    _line_limit = {"short": "不超過 12 字", "long": "不超過 35 字"}.get(
        req.line_length or "standard", "不超過 20 字"
    )
    prompt = f"""你是台灣兒童繪本對話作家。
場景：{req.scene_description}
風格：{req.style}
角色：{req.character_name}{personality_note}{prev_context}

請為角色「{req.character_name}」生成 3 條風格各異、自然口語的下一句台詞建議。

要求：
- 使用台灣繁體中文，符合台灣用語
- 每條台詞{_line_limit}，適合大聲朗讀
- 符合角色個性，且自然銜接前面的對話
- 直接輸出 JSON，不要任何說明：
{{"suggestions": ["台詞1", "台詞2", "台詞3"]}}"""

    suggestions = await _llm_suggestions(
        prompt,
        temperature=0.9,
        max_tokens=250,
        groq_timeout=20,
        minimax_timeout=30,
        endpoint_name="suggest-line",
    )
    if suggestions:
        return {"suggestions": suggestions}
    raise HTTPException(status_code=502, detail="台詞建議生成失敗")


@app.post("/api/generate-script", response_model=ScriptResponse)
async def generate_script(req: GenerateScriptRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_script.is_allowed(ip):
        raise _rl_429(_rl_script, ip)
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未正確設定，請聯絡管理員")

    character_desc = "\n".join([
        f"- {c.name}（ID: {c.id}，個性：{c.personality}"
        + (f"，外形：{c.visual_description}" if c.visual_description else "")
        + f"，聲音類型：{c.voice_id}）"
        for c in req.characters
    ])

    line_length_rule = _LINE_LENGTH_RULES.get(req.line_length or "standard", _LINE_LENGTH_RULES["standard"])
    line_count_rule = _LINE_COUNT_RULES.get(req.line_count or "standard", _LINE_COUNT_RULES["standard"])
    age_group_rule = _AGE_GROUP_RULES.get(req.age_group or "child", _AGE_GROUP_RULES["child"])

    _raw_style = (req.image_style or "").strip()
    _img_style = _IMAGE_STYLE_EN.get(_raw_style, _raw_style) or "watercolor children's book illustration"

    # Pre-extract character visual descriptions so the LLM can embed them
    # directly in the scene_prompt for better FLUX image generation quality.
    # Fall back to the emoji hint table when visual_description is not set.
    _char_visual_parts = []
    for c in req.characters:
        if c.visual_description:
            _char_visual_parts.append(f"{c.name}: {c.visual_description}")
        elif c.emoji and c.emoji in _EMOJI_VISUAL_HINTS:
            _char_visual_parts.append(f"{c.name}: {_EMOJI_VISUAL_HINTS[c.emoji]}")
    _char_visual_note = (
        f" Character appearances to include — {'; '.join(_char_visual_parts)}."
        if _char_visual_parts else ""
    )

    mood_line = f"情感基調：{req.mood}\n" if req.mood else ""
    mood_rule = f"- 整幕對話必須呈現「{req.mood}」的情感基調，措辭、節奏與情緒表達皆須與此一致\n" if req.mood else ""

    prompt = f"""你是一位台灣繪本故事作家。請根據以下場景和角色，生成一段繪本對話劇本。

場景描述：{req.scene_description}
風格：{req.style}
{mood_line}角色列表：
{character_desc}

請回傳 JSON 格式，結構如下：
{{
  "lines": [
    {{
      "character_name": "角色名稱",
      "character_id": "角色ID（原封不動複製）",
      "voice_id": "聲音ID（原封不動複製）",
      "text": "這個角色說的話（自然口語，適合大聲朗讀）",
      "emotion": "happy|sad|angry|surprised|fearful|disgusted|neutral 其中一個（開心|難過|生氣|驚訝|害怕|厭惡|平靜）"
    }}
  ],
  "scene_prompt": "English image generation prompt for FLUX AI, {_img_style} style.{_char_visual_note} Describe each character's exact visual details first (body shape, colors, clothing, accessories, expression), then the scene background and mood. Use specific visual adjectives. 40-70 words total.",
  "sfx_description": "建議的背景音效描述（例如：森林鳥鳴聲、輕柔鋼琴音樂）",
  "scene_title": "4～8個繁體中文字的幕次標題（例如：「森林初遇」「神奇地圖」「勇氣的抉擇」）"
}}

注意：
- 請使用台灣繁體中文，符合台灣的語言習慣與用語，避免使用中國大陸用語
- 對話要自然有趣，適合兒童
- 每個角色至少說一句話
{age_group_rule}
{line_count_rule}
{line_length_rule}
- 角色在台詞中稱呼其他角色時，只能使用角色列表中的名字，不得自行發明暱稱或別名
{mood_rule}- scene_title 必須是 4～8 個繁體中文字，簡潔有力，概括本幕主題，不含標點符號
- 直接輸出 JSON，不要思考過程，不要其他說明
"""

    if req.story_context:
        prompt += f"\n前情提要（請確保本幕故事自然銜接前情，劇情持續發展，不重複前幕內容）：\n{req.story_context}\n"

    if req.is_ending:
        prompt += "\n【重要：這是故事的最後一幕】請讓故事圓滿收場：主要衝突得到解決，角色學到了重要的道理，帶給讀者溫馨感動的結束感受，傳達正向寓意。\n"

    async def _call_minimax_script() -> str:
        try:
            resp = await _http_client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.8,
                    "max_tokens": 2000,
                },
                timeout=90,
            )
        except (httpx.TimeoutException, httpx.RequestError) as e:
            raise RuntimeError(f"MiniMax network error: {e}") from e
        if resp.status_code != 200:
            raise RuntimeError(f"MiniMax HTTP {resp.status_code}")
        try:
            message = resp.json()["choices"][0]["message"]
            if isinstance(message["content"], list):
                return " ".join(
                    block.get("text", "") for block in message["content"]
                    if block.get("type") == "text"
                )
            return str(message["content"])
        except (KeyError, IndexError) as e:
            raise RuntimeError(f"MiniMax response format error: {e}") from e

    async def _call_groq_script() -> str:
        resp = await _http_client.post(
            GROQ_CHAT_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": GROQ_QUALITY_MODEL,  # script gen needs full 70B reasoning
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.8,
                "max_tokens": 1500,
            },
            timeout=60,
        )
        resp.raise_for_status()
        raw = resp.json()["choices"][0]["message"].get("content", "")
        return str(raw)

    # Try MiniMax first (higher quality, handles Chinese natively).
    # On any failure, fall back to Groq GROQ_QUALITY_MODEL.
    content: str | None = None
    last_error: Exception | None = None

    if MINIMAX_API_KEY:
        try:
            content = await _call_minimax_script()
            logger.info("generate-script via MiniMax (%d chars)", len(content))
        except Exception as e:
            logger.warning("generate-script MiniMax failed: %s — trying Groq fallback", e)
            last_error = e

    if content is None and GROQ_API_KEY:
        try:
            content = await _call_groq_script()
            logger.info("generate-script via Groq fallback (%d chars)", len(content))
        except Exception as e:
            logger.warning("generate-script Groq fallback failed: %s", e)
            last_error = e

    if content is None:
        if isinstance(last_error, httpx.TimeoutException):
            raise HTTPException(status_code=504, detail="請求逾時，請稍後重試")
        raise HTTPException(status_code=502, detail="AI 服務暫時無法使用，請稍後重試")

    # 移除 <think>...</think> 思考區塊
    # M2.7 sometimes places the entire answer inside <think>; save raw so we can search it as fallback
    raw_llm_content = content
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
    if not content:
        logger.info("stripped content empty — searching inside think block for JSON")
        content = raw_llm_content
    logger.info("LLM cleaned content: %s", content[:300])

    # 方式1：```json ... ``` 或 ``` ... ```
    # Use greedy .*  (not .*?) so nested braces inside the code fence are included.
    # Non-greedy .*? would stop at the FIRST closing brace and truncate nested JSON.
    code_block = re.search(r"```(?:json)?\s*(\{.*\})\s*```", content, re.DOTALL)
    if code_block:
        content = code_block.group(1)
    else:
        # 方式2：直接找第一個 { ... } 大括號區塊
        brace_match = re.search(r"\{.*\}", content, re.DOTALL)
        if brace_match:
            content = brace_match.group(0)

    def _repair_llm_json(s: str) -> str:
        """Repair common LLM JSON mistakes so json.loads can parse them.

        Only called when the initial parse fails, so there is zero overhead on success.

        Fixes applied (in order):
        1. Trailing commas before } or ] — valid in JS but rejected by Python json.
           Example: {"lines": [...],} → {"lines": [...]}
        2. Python-style literals — LLMs fine-tuned on Python code sometimes emit
           True/False/None instead of the JSON-spec true/false/null.
           Safe to replace unconditionally: these words don't appear in Chinese dialogue,
           and the replacement is only attempted after a parse failure anyway.
        """
        s = re.sub(r',\s*([}\]])', r'\1', s)
        s = re.sub(r'\bTrue\b', 'true', s)
        s = re.sub(r'\bFalse\b', 'false', s)
        s = re.sub(r'\bNone\b', 'null', s)
        return s

    try:
        data = json.loads(content)
    except Exception:
        try:
            data = json.loads(_repair_llm_json(content))
            logger.info("generate-script: JSON repaired (trailing commas / Python literals)")
        except Exception as e:
            logger.error("JSON parse failed after repair: %s\nContent: %s", e, content[:800])
            raise HTTPException(status_code=502, detail=f"劇本解析失敗，請重試（{type(e).__name__}）")

    # Normalize character fields: the LLM may hallucinate character_id or voice_id.
    # Map each line back to canonical character data from req.characters.
    char_by_id   = {c.id: c for c in req.characters}
    char_by_name = {c.name.strip(): c for c in req.characters}

    # Guard: ensure lines is a list and drop any entries missing text
    raw_lines = data.get("lines")
    if not isinstance(raw_lines, list):
        data["lines"] = []
    else:
        data["lines"] = [l for l in raw_lines if isinstance(l, dict) and str(l.get("text", "")).strip()]

    for line in data.get("lines", []):
        char = char_by_id.get(str(line.get("character_id", "")))
        if char is None:
            char = char_by_name.get(str(line.get("character_name", "")).strip())
        if char is None and req.characters:
            char = req.characters[0]
        if char:
            line["character_id"]   = char.id
            line["character_name"] = char.name
            line["voice_id"]       = char.voice_id

    try:
        return ScriptResponse(**data)
    except Exception as e:
        logger.error("ScriptResponse build failed: %s\nData: %s", e, str(data)[:800])
        raise HTTPException(status_code=502, detail=f"劇本解析失敗，請重試（{type(e).__name__}）")

# 情緒語調：rate（語速）+ volume（音量）傳給 edge-tts 原生 prosody 參數
# 不使用 mstts:express-as — edge-tts 會把傳入的文字包在自己的 <speak> 裡，
# 若再傳完整 SSML 文件會造成雙層巢狀 <speak>，導致 TTS 把 XML 屬性名當成文字朗讀。
_EMOTION_PROSODY: dict[str, dict[str, str]] = {
    "happy":     {"rate": "+8%",  "volume": "+8%"},    # 開心：稍快、聲音飽滿
    "sad":       {"rate": "-15%", "volume": "-12%"},   # 難過：慢而輕柔
    "angry":     {"rate": "+15%", "volume": "+18%"},   # 生氣：急促大聲
    "surprised": {"rate": "+5%",  "volume": "+14%"},   # 驚訝：音量拉高
    "fearful":   {"rate": "-8%",  "volume": "-15%"},   # 害怕：慢而輕
    "disgusted": {"rate": "-8%",  "volume": "-8%"},    # 厭惡：低沉緩慢
    "neutral":   {"rate": "+0%",  "volume": "+0%"},
}

# 角色音調偏移（pitch，單位 Hz）
# edge-tts 台灣腔只有 3 個實際聲音，用 pitch 讓同聲音的不同 voice_id 聽起來有個性差異
_VOICE_PITCH: dict[str, str] = {
    "cn-natural-female":      "+0Hz",    # XiaoxiaoNeural：標準（原聲最自然）
    "cn-natural-male":        "+0Hz",    # YunxiNeural：標準
    "cn-story-male":          "-5Hz",    # YunyangNeural：稍低沉有磁性
    "cn-child-girl":          "+20Hz",   # XiaoyiNeural：偏高，強化孩童感
    "cn-girl-clear":          "+10Hz",   # YunxiaNeural：稍高
    "cn-girl-soft":           "-8Hz",    # XiaoxiaoNeural：偏低，溫柔安靜感
    "female-yujie":           "+0Hz",    # 御姐音：標準
    "male-qn-qingse":         "+10Hz",   # 青澀男聲：偏高（年輕感）
    "male-qn-jingying":       "+0Hz",    # 精英男聲：標準
    "male-qn-badao":          "-10Hz",   # 霸道男聲：偏低
    "presenter_male":         "-5Hz",    # 播報男聲：稍低沉
    "audiobook_male_2":       "-8Hz",    # 說書男聲：低沉有磁性
    "audiobook_female_2":     "-5Hz",    # 說書女聲：穩重
    "cute_boy":               "+25Hz",   # 可愛男孩：明顯偏高
    "elderly_man":            "-20Hz",   # 老爺爺：低沉蒼老
    "elderly_woman":          "-10Hz",   # 老奶奶：稍低
}


def _prepare_tts_text(text: str) -> str:
    """Return text ready for edge-tts.

    edge-tts 7.x internally applies xml.sax.saxutils.escape() before embedding
    text into SSML.  We must therefore pass raw, unescaped text — any pre-escaping
    we do would be double-escaped (e.g. & → &amp; → &amp;amp;), and any SSML tags
    we inject (e.g. <break/>) would be escaped to &lt;break/&gt; and read aloud
    as literal characters including "斜線" for the slash.
    """
    return text.strip()


def _emotion_prosody_params(emotion: Optional[str], voice_id: str = "") -> dict[str, str]:
    """Return edge-tts constructor kwargs (rate, volume, pitch) for the given emotion + voice."""
    p = _EMOTION_PROSODY.get(emotion or "neutral", {"rate": "+0%", "volume": "+0%"})
    rate   = p.get("rate",   "+0%")
    volume = p.get("volume", "+0%")
    pitch  = _VOICE_PITCH.get(voice_id, "+0Hz")
    # edge-tts requires an explicit sign prefix on rate/volume
    if rate   and not rate.startswith(('+', '-')):
        rate   = f"+{rate}"
    if volume and not volume.startswith(('+', '-')):
        volume = f"+{volume}"
    return {"rate": rate, "volume": volume, "pitch": pitch}

# ── 端點：生成語音 ────────────────────────────────────────────
# 優先順序：科大訊飛（設定後）→ Edge TTS → Groq Orpheus（緊急備用）
@app.post("/api/generate-voice")
async def generate_voice(req: GenerateVoiceRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_voice.is_allowed(ip):
        raise _rl_429(_rl_voice, ip)

    # ── 0. LRU 快取命中（相同 voice_id + emotion + text → 直接返回）──────
    _cache_key = (req.voice_id, req.emotion or "", req.text)
    _cached = _tts_cache_get(_cache_key)
    if _cached:
        logger.info("TTS cache hit voice_id=%s emotion=%s len=%d", req.voice_id, req.emotion, len(req.text))
        return {"audio_base64": base64.b64encode(_cached[0]).decode("utf-8"), "format": _cached[1]}

    # ── 1. 科大訊飛（若已設定 API 金鑰）────────────────────────
    if XFYUN_APP_ID and XFYUN_API_KEY and XFYUN_API_SECRET:
        try:
            audio_bytes = await _generate_voice_xfyun(req.text, req.voice_id, req.emotion)
            if audio_bytes:
                logger.info("TTS xfyun ok voice_id=%s", req.voice_id)
                _tts_cache_put(_cache_key, audio_bytes, "mp3")
                return {"audio_base64": base64.b64encode(audio_bytes).decode("utf-8"), "format": "mp3"}
            logger.warning("iFlytek TTS returned empty audio")
        except Exception as e:
            logger.warning("iFlytek TTS failed, falling back to Edge TTS: %s", e)

    # ── 2. Microsoft Edge TTS（免費，台灣腔）────────────────────
    # Do NOT pass a full <speak> SSML document — edge-tts wraps text in its own
    # <speak> element internally, causing double-nesting and reading XML tags aloud.
    edge_voice = VOICE_TO_EDGE.get(req.voice_id, "zh-TW-HsiaoYuNeural")
    prosody    = _emotion_prosody_params(req.emotion, req.voice_id)
    logger.info("TTS edge voice_id=%s emotion=%s → %s rate=%s vol=%s pitch=%s",
                req.voice_id, req.emotion, edge_voice, prosody["rate"], prosody["volume"], prosody["pitch"])
    try:
        communicate = edge_tts.Communicate(
            text=_prepare_tts_text(req.text),
            voice=edge_voice,
            rate=prosody["rate"],
            volume=prosody["volume"],
            pitch=prosody["pitch"],
        )
        audio_buffer = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buffer.write(chunk["data"])
        audio_bytes = audio_buffer.getvalue()
        if audio_bytes:
            _tts_cache_put(_cache_key, audio_bytes, "mp3")
            return {"audio_base64": base64.b64encode(audio_bytes).decode("utf-8"), "format": "mp3"}
        logger.warning("Edge TTS returned empty audio")
    except Exception as e:
        logger.warning("Edge TTS error: %s", e)

    # ── 備用：Groq Orpheus（英文聲音，僅供緊急 fallback）────
    if GROQ_API_KEY:
        groq_voice = VOICE_TO_GROQ.get(req.voice_id, "diana")
        logger.info("Fallback groq_voice=%s", groq_voice)
        try:
            resp = await _http_client.post(
                GROQ_TTS_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "canopylabs/orpheus-v1-english",
                    "input": req.text,
                    "voice": groq_voice,
                    "response_format": "wav",
                },
                timeout=30,
            )
            if resp.status_code == 200 and resp.content:
                _tts_cache_put(_cache_key, resp.content, "wav")
                audio_b64 = base64.b64encode(resp.content).decode("utf-8")
                return {"audio_base64": audio_b64, "format": "wav"}
            logger.warning("Groq TTS error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("Groq TTS exception: %s", e)

    raise HTTPException(status_code=502, detail="語音生成失敗，請稍後重試")

# ── 本機備用：使用 Pillow 生成童書風格插圖（無需外部 API）────────────
def _generate_scene_image_pillow(prompt: str, width: int = 800, height: int = 600) -> str:
    """
    Procedurally generate a watercolor children's-book-style scene illustration.
    Used as the last-resort fallback when all external image APIs are unavailable.
    Returns a base64-encoded JPEG.
    """
    try:
        from PIL import Image, ImageDraw, ImageFilter  # type: ignore
    except ImportError:
        raise RuntimeError("Pillow not installed")

    p   = prompt.lower()
    # Use a stable, PYTHONHASHSEED-independent seed so the same prompt always
    # produces the same fallback image across container restarts.
    # Python's built-in hash() is randomised by default (PYTHONHASHSEED), which
    # would generate a different image on every deploy for the same scene.
    rng = random.Random(int(hashlib.md5(prompt.encode()).hexdigest()[:8], 16))

    # ── scene detection ───────────────────────────────────────────────
    is_night  = any(w in p for w in ['night', 'moon', '夜', '晚', '星', 'star', 'dark'])
    is_beach  = any(w in p for w in ['sea', 'ocean', 'beach', '海', '沙灘', 'wave', '浪'])
    is_city   = any(w in p for w in ['city', 'town', 'street', '城市', '街道', '房子', 'building'])
    is_snow   = any(w in p for w in ['snow', 'mountain', '山', '雪', '冰', 'winter'])
    is_forest = any(w in p for w in ['forest', 'tree', '森林', '樹', '林', 'jungle', 'wood'])
    is_indoor = any(w in p for w in ['room', 'home', 'house', 'inside', '室內', '家', '房間'])

    # ── colour palette ────────────────────────────────────────────────
    if is_night:
        sky1, sky2   = (18, 12, 58), (48, 32, 110)
        hill1, hill2 = (22, 58, 35), (18, 45, 28)
        ground_top   = (25, 65, 38)
    elif is_beach:
        sky1, sky2   = (90, 185, 255), (185, 230, 255)
        hill1, hill2 = (225, 210, 148), (205, 188, 120)
        ground_top   = (230, 215, 155)
    elif is_city:
        sky1, sky2   = (138, 192, 240), (208, 232, 255)
        hill1, hill2 = (155, 152, 148), (135, 132, 130)
        ground_top   = (165, 160, 155)
    elif is_snow:
        sky1, sky2   = (155, 208, 252), (218, 238, 255)
        hill1, hill2 = (210, 228, 212), (195, 215, 198)
        ground_top   = (235, 245, 240)
    elif is_indoor:
        sky1, sky2   = (240, 225, 195), (255, 245, 220)   # warm interior wall
        hill1, hill2 = (185, 155, 120), (165, 138, 105)
        ground_top   = (195, 168, 130)
    else:  # sunny meadow / forest
        sky1, sky2   = (100, 190, 255), (190, 232, 255)
        hill1, hill2 = (60, 148, 68), (45, 130, 55)
        ground_top   = (72, 158, 72)

    img  = Image.new('RGB', (width, height))
    draw = ImageDraw.Draw(img)

    horizon = int(height * 0.60)

    # ─────────────────────────────────────────────────────────────────
    # 1. Sky gradient
    # ─────────────────────────────────────────────────────────────────
    for y in range(horizon + 20):
        t = y / max(horizon + 20, 1)
        row = tuple(int(sky1[i] + (sky2[i] - sky1[i]) * t) for i in range(3))
        draw.line([(0, y), (width, y)], fill=row)  # type: ignore[arg-type]

    # ─────────────────────────────────────────────────────────────────
    # 2. Distant rolling hills (background)
    # ─────────────────────────────────────────────────────────────────
    def _hill_row(base_y: int, amplitude: int, period: int, col: tuple, phase: float = 0.0):
        pts = [(0, height)]
        for x in range(0, width + 1, 4):
            y_val = base_y + int(amplitude * math.sin((x / period + phase) * math.pi * 2))
            pts.append((x, y_val))
        pts.append((width, height))
        draw.polygon(pts, fill=col)  # type: ignore[arg-type]

    _hill_row(horizon - 40, 22, 220, hill1, phase=0.1 + rng.random() * 0.3)
    _hill_row(horizon - 18, 15, 170, hill2, phase=0.5 + rng.random() * 0.3)

    # ─────────────────────────────────────────────────────────────────
    # 3. Ground
    # ─────────────────────────────────────────────────────────────────
    for y in range(horizon, height):
        t  = (y - horizon) / max(height - horizon, 1)
        dr = int(ground_top[0] * (1 - t * 0.3))
        dg = int(ground_top[1] * (1 - t * 0.28))
        db = int(ground_top[2] * (1 - t * 0.22))
        draw.line([(0, y), (width, y)], fill=(dr, dg, db))

    # ─────────────────────────────────────────────────────────────────
    # 4. Sun / moon
    # ─────────────────────────────────────────────────────────────────
    sx, sy = width - 105, 35
    sr     = 38
    if is_night:
        # Moon with crescent
        draw.ellipse([sx-sr, sy-sr, sx+sr, sy+sr], fill=(248, 243, 208))
        draw.ellipse([sx-sr+14, sy-sr-6, sx+sr+14, sy+sr-6], fill=sky1)  # crescent shadow
        # Star cluster near moon
        for _ in range(6):
            stx = rng.randint(sx-90, sx+30)
            sty = rng.randint(sy-30, sy+30)
            draw.ellipse([stx-2, sty-2, stx+2, sty+2], fill=(255, 255, 220))
    else:
        # Sun with soft glow rings
        for glow in [sr+22, sr+14, sr+6]:
            alpha = int(28 - glow * 0.5)
            glow_col = (255, 245, 160, max(0, alpha))
            draw.ellipse([sx-glow, sy-glow, sx+glow, sy+glow], fill=(255, 245, 160))
        draw.ellipse([sx-sr, sy-sr, sx+sr, sy+sr], fill=(255, 228, 50))

    # ─────────────────────────────────────────────────────────────────
    # 5. Clouds / stars
    # ─────────────────────────────────────────────────────────────────
    if is_night:
        for _ in range(55):
            stx = rng.randint(0, width)
            sty = rng.randint(0, horizon - 15)
            sr2 = rng.choice([1, 1, 1, 2])
            draw.ellipse([stx-sr2, sty-sr2, stx+sr2, sty+sr2], fill=(255, 255, 220))
    else:
        cloud_positions = [
            (rng.randint(60, 200), rng.randint(35, 90)),
            (rng.randint(280, 420), rng.randint(25, 70)),
            (rng.randint(500, 650), rng.randint(40, 85)),
        ]
        for cx, cy in cloud_positions:
            # Fluffy cloud from overlapping ellipses
            for dx, dy, cr in [(-35, 5, 30), (-12, -10, 38), (16, -8, 34),
                                (40, 5, 28), (20, 12, 24), (-20, 12, 22)]:
                draw.ellipse([cx+dx-cr, cy+dy-cr, cx+dx+cr, cy+dy+cr],
                             fill=(255, 255, 255))

    # ─────────────────────────────────────────────────────────────────
    # 6. Scene-specific background elements
    # ─────────────────────────────────────────────────────────────────
    def _draw_round_tree(tx: int, th: int, trunk_col: tuple, leaf_col: tuple):
        tw = 9
        # trunk
        draw.rectangle([tx-tw, horizon-6, tx+tw, horizon+30], fill=trunk_col)
        # round canopy: 3 stacked ellipses → lollipop tree
        cy_base = horizon - th
        radii   = [int(th * 0.38), int(th * 0.32), int(th * 0.24)]
        leaf_light = tuple(min(255, c + 28) for c in leaf_col)
        for i, rad in enumerate(radii):
            offset_y = i * int(th * 0.22)
            col = leaf_col if i % 2 == 0 else leaf_light
            draw.ellipse([tx-rad, cy_base+offset_y-rad//2,
                          tx+rad, cy_base+offset_y+rad//2+rad//4], fill=col)  # type: ignore[arg-type]

    def _draw_flower(fx: int, fy: int, fc: tuple):
        draw.line([(fx, fy), (fx, fy+18)], fill=(80, 155, 65), width=2)
        petal_offsets = [(0,-8),(6,-5),(6,5),(0,8),(-6,5),(-6,-5)]
        for px, py in petal_offsets:
            draw.ellipse([fx+px-5, fy+py-5, fx+px+5, fy+py+5], fill=fc)
        draw.ellipse([fx-4, fy-4, fx+4, fy+4], fill=(255, 240, 60))

    if is_forest or (not is_beach and not is_city and not is_snow and not is_indoor):
        trunk_col = (120, 82, 44)
        leaf_cols = [
            (52, 140, 68), (40, 125, 55), (68, 155, 72),
            (45, 148, 62), (75, 160, 58), (35, 118, 50),
        ]
        step = rng.randint(72, 100)
        for tx in range(-30, width + 60, step):
            tx += rng.randint(-15, 15)
            th   = rng.randint(105, 195)
            lcol = rng.choice(leaf_cols)
            _draw_round_tree(tx, th, trunk_col, lcol)
        # Foreground flowers
        flower_cols = [(255, 88, 100), (255, 175, 45), (210, 75, 210), (80, 185, 255), (255, 130, 180)]
        for _ in range(18):
            fx = rng.randint(10, width - 10)
            fy = rng.randint(horizon + 5, min(horizon + 80, height - 20))
            _draw_flower(fx, fy, rng.choice(flower_cols))

    elif is_beach:
        # Waves layered
        wave_cols = [(70, 170, 230), (95, 195, 245), (130, 215, 255)]
        for wrow, wc in enumerate(wave_cols):
            wy = horizon + 8 + wrow * 28
            for wx in range(0, width, 55):
                draw.arc([wx, wy-12, wx+55, wy+12], 0, 180, fill=wc, width=4)
        # Palm trees
        for tx in [120, width - 160]:
            th = rng.randint(120, 170)
            draw.line([(tx, horizon+20), (tx+30, horizon-th)], fill=(150, 110, 55), width=10)
            leaf_cx, leaf_cy = tx+30, horizon-th
            for angle_offset in range(0, 360, 55):
                rad = math.radians(angle_offset)
                ex  = leaf_cx + int(math.cos(rad) * 60)
                ey  = leaf_cy + int(math.sin(rad) * 30)
                draw.line([(leaf_cx, leaf_cy), (ex, ey)], fill=(55, 155, 55), width=5)

    elif is_city:
        # Buildings with variation
        bx = 0
        while bx < width:
            bw   = rng.randint(58, 92)
            bh   = rng.randint(90, 220)
            hue  = rng.choice([(180, 165, 155), (165, 178, 188), (188, 172, 158),
                                (195, 185, 170), (175, 168, 180)])
            draw.rectangle([bx, horizon - bh, bx + bw, horizon + 5], fill=hue)
            # windows
            for wy in range(horizon - bh + 18, horizon - 8, 24):
                for wx in range(bx + 8, bx + bw - 8, 20):
                    wc = (255, 245, 155) if rng.random() > 0.30 else (130, 160, 195)
                    draw.rectangle([wx, wy, wx + 10, wy + 14], fill=wc)
            bx += bw + rng.randint(2, 8)

    elif is_snow:
        # Snow-covered mountains
        for mi in range(3):
            mx   = int(width * (0.2 + mi * 0.3)) + rng.randint(-30, 30)
            mh   = rng.randint(180, 280)
            mw   = rng.randint(160, 220)
            mbase_col = (165, 185, 168)
            draw.polygon([(mx - mw, horizon + 5), (mx, horizon - mh), (mx + mw, horizon + 5)],
                         fill=mbase_col)
            # snow cap
            cap_h = int(mh * 0.35)
            draw.polygon([(mx - int(mw * 0.38), horizon - mh + cap_h),
                          (mx, horizon - mh - 4),
                          (mx + int(mw * 0.38), horizon - mh + cap_h)],
                         fill=(242, 248, 252))
        # Snowflakes
        for _ in range(30):
            sx2 = rng.randint(0, width)
            sy2 = rng.randint(0, height - 20)
            sr3 = rng.choice([2, 2, 3, 4])
            draw.ellipse([sx2 - sr3, sy2 - sr3, sx2 + sr3, sy2 + sr3], fill=(245, 250, 255))

    elif is_indoor:
        # Floor boards
        for fy in range(horizon, height, 35):
            draw.line([(0, fy), (width, fy)], fill=(155, 125, 88), width=2)
        # Window on wall
        wx0, wy0, wx1, wy1 = 580, 60, 740, 220
        draw.rectangle([wx0, wy0, wx1, wy1], fill=(185, 225, 255))
        draw.rectangle([wx0, wy0, wx1, wy1], outline=(160, 130, 90), width=6)
        draw.line([(wx0, (wy0+wy1)//2), (wx1, (wy0+wy1)//2)], fill=(160, 130, 90), width=4)
        draw.line([((wx0+wx1)//2, wy0), ((wx0+wx1)//2, wy1)], fill=(160, 130, 90), width=4)

    # ─────────────────────────────────────────────────────────────────
    # 7. Foreground path / road
    # ─────────────────────────────────────────────────────────────────
    if not is_beach and not is_city and not is_indoor:
        path_col  = (200, 185, 148) if not is_snow else (225, 235, 238)
        path_pts  = [
            (int(width * 0.38), horizon + 2),
            (int(width * 0.28), height),
            (int(width * 0.72), height),
            (int(width * 0.62), horizon + 2),
        ]
        draw.polygon(path_pts, fill=path_col)

    # ─────────────────────────────────────────────────────────────────
    # 8. Simple character silhouettes (1-2 cute blob figures)
    # ─────────────────────────────────────────────────────────────────
    char_cols = [(255, 180, 100), (160, 220, 255), (255, 150, 180),
                 (180, 255, 160), (255, 215, 80), (210, 170, 255)]
    n_chars = 2 if any(c in p for c in ['and', '和', '與', '兩', '朋友']) else 1
    char_xs = [int(width * 0.42), int(width * 0.58)] if n_chars == 2 else [int(width * 0.50)]
    for ci, char_x in enumerate(char_xs):
        char_y   = horizon + 15
        body_col = rng.choice(char_cols)
        ear_col  = tuple(max(0, c - 25) for c in body_col)
        # ears
        draw.ellipse([char_x - 14, char_y - 42, char_x - 4, char_y - 28], fill=ear_col)  # type: ignore[arg-type]
        draw.ellipse([char_x + 4,  char_y - 42, char_x + 14, char_y - 28], fill=ear_col)  # type: ignore[arg-type]
        # head
        draw.ellipse([char_x - 18, char_y - 35, char_x + 18, char_y - 5], fill=body_col)
        # body
        draw.ellipse([char_x - 16, char_y - 10, char_x + 16, char_y + 30], fill=body_col)
        # eyes
        draw.ellipse([char_x - 8, char_y - 26, char_x - 3, char_y - 21], fill=(60, 40, 30))
        draw.ellipse([char_x + 3, char_y - 26, char_x + 8, char_y - 21], fill=(60, 40, 30))
        # smile
        draw.arc([char_x - 7, char_y - 19, char_x + 7, char_y - 8], 15, 165, fill=(60, 40, 30), width=2)
        # shadow
        draw.ellipse([char_x - 18, char_y + 26, char_x + 18, char_y + 34],
                     fill=tuple(max(0, c - 18) for c in (ground_top[0], ground_top[1], ground_top[2])))  # type: ignore[arg-type]

    # ─────────────────────────────────────────────────────────────────
    # 9. Watercolor paper texture overlay (light noise)
    # ─────────────────────────────────────────────────────────────────
    img = img.filter(ImageFilter.GaussianBlur(radius=1.4))
    # Vignette-like darkening at edges
    vig     = Image.new('RGB', (width, height), (0, 0, 0))
    vdraw   = ImageDraw.Draw(vig)
    for step in range(15):
        margin = step * 5
        alpha  = int(12 - step * 0.6)
        if alpha <= 0:
            break
        vdraw.rectangle([margin, margin, width - margin, height - margin],
                        outline=(0, 0, 0))
    img = Image.blend(img, vig, 0.08)

    # ─────────────────────────────────────────────────────────────────
    # 10. Decorative storybook border
    # ─────────────────────────────────────────────────────────────────
    border_draw = ImageDraw.Draw(img)
    border_col  = (180, 145, 100) if not is_night else (120, 110, 165)
    for bw2 in [4, 9]:
        border_draw.rectangle([bw2, bw2, width - bw2, height - bw2],
                               outline=border_col, width=2)

    # ─────────────────────────────────────────────────────────────────
    # Encode
    # ─────────────────────────────────────────────────────────────────
    buf = io.BytesIO()
    img.save(buf, format='JPEG', quality=88, optimize=True)
    return base64.b64encode(buf.getvalue()).decode('utf-8')


# ── 端點：生成場景圖片（HuggingFace → Pollinations → Pillow）─────────
@app.post("/api/generate-image")
async def generate_image(req: GenerateImageRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_image.is_allowed(ip):
        raise _rl_429(_rl_image, ip)

    # Use the caller-supplied seed for cross-scene consistency; fall back to
    # a random seed when none is provided (e.g. standalone regen without context).
    _seed = req.seed if req.seed is not None else random.randint(1, 2147483647)
    full_prompt = f"{req.prompt}, soft colors, child-friendly, high quality, consistent character design"

    # ── 優先：HuggingFace Inference API（HUGGINGFACE_API_KEY）────
    if HUGGINGFACE_API_KEY:
        try:
            resp = await _http_client.post(
                HF_INFERENCE_URL,
                headers={"Authorization": f"Bearer {HUGGINGFACE_API_KEY}", "Content-Type": "application/json"},
                json={
                    "inputs": full_prompt,
                    "parameters": {
                        "seed": _seed,
                        "num_inference_steps": 4,
                        "guidance_scale": 0.0,
                        # 1024×768 landscape matches Pollinations and Pillow fallback.
                        # Both dimensions are multiples of 64 (required by FLUX.1-schnell)
                        # and produce a 4:3 aspect ratio suited to picturebook pages.
                        "width": 1024,
                        "height": 768,
                    },
                },
                timeout=60,
            )
            if resp.status_code == 200 and resp.content:
                b64 = base64.b64encode(resp.content).decode("utf-8")
                mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                logger.info("HF image OK seed=%d size=%d bytes", _seed, len(resp.content))
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("HF image error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("HF image exception: %s", e)

    # ── 備用：Pollinations.ai → fetch 回來轉成 base64 ─────────────
    # gen.pollinations.ai/image/{prompt} 需要 API key（免費方案可申請）
    # 設定 POLLINATIONS_API_KEY 環境變數即可啟用；未設定則跳過（避免 401 延遲）
    if POLLINATIONS_API_KEY:
        encoded   = urllib.parse.quote(full_prompt)
        seed      = _seed % 99999 + 1  # Pollinations accepts 1-99999
        image_url = (
            f"https://gen.pollinations.ai/image/{encoded}"
            f"?width=1024&height=768&nologo=true&seed={seed}&model=flux"
        )
        logger.info("Pollinations fetch: %s", image_url[:200])
        try:
            img_resp = await _http_client.get(
                image_url,
                headers={"Authorization": f"Bearer {POLLINATIONS_API_KEY}"},
                timeout=90,
                follow_redirects=True,
            )
            if img_resp.status_code == 200 and img_resp.content:
                mime = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
                if not mime.startswith("image/"):
                    mime = "image/jpeg"
                b64 = base64.b64encode(img_resp.content).decode("utf-8")
                logger.info("Pollinations fetch OK, size=%d bytes", len(img_resp.content))
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("Pollinations returned status %s", img_resp.status_code)
        except Exception as e:
            logger.warning("Pollinations fetch failed: %s", e)

    # ── 最終備用：Pillow 本機生成場景插圖（無外部 API）────────────────
    try:
        b64 = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _generate_scene_image_pillow(req.prompt)
        )
        logger.info("Pillow fallback image generated for prompt: %s", req.prompt[:80])
        return {"url": f"data:image/jpeg;base64,{b64}"}
    except Exception as e:
        logger.warning("Pillow image generation failed: %s", e)

    raise HTTPException(status_code=502, detail="插圖生成失敗，請點「重新生成插圖」再試一次")


# ── 端點：角色肖像生成 ────────────────────────────────────────
class GeneratePortraitRequest(BaseModel):
    name: str = Field(..., max_length=30)
    visual_description: str = Field(..., min_length=1, max_length=200)
    emoji: Optional[str] = Field(None, max_length=10)
    image_style: Optional[str] = Field(None, max_length=80)


@app.post("/api/generate-character-portrait")
async def generate_character_portrait(req: GeneratePortraitRequest, request: Request):
    """Generate a square character portrait using the same image chain as generate_image."""
    ip = _client_ip(request)
    if not _rl_image.is_allowed(ip):
        raise _rl_429(_rl_image, ip)

    style_hint = req.image_style or "watercolor children's book illustration"
    _seed = random.randint(1, 2147483647)
    full_prompt = (
        f"character portrait of {req.name}, {req.visual_description}, "
        f"{style_hint}, centered composition, plain soft background, "
        f"square format, child-friendly, expressive face, high quality"
    )

    # ── HuggingFace ────────────────────────────────────────────
    if HUGGINGFACE_API_KEY:
        try:
            resp = await _http_client.post(
                HF_INFERENCE_URL,
                headers={"Authorization": f"Bearer {HUGGINGFACE_API_KEY}", "Content-Type": "application/json"},
                json={
                    "inputs": full_prompt,
                    "parameters": {
                        "seed": _seed,
                        "num_inference_steps": 4,
                        "guidance_scale": 0.0,
                        "width": 512,
                        "height": 512,
                    },
                },
                timeout=60,
            )
            if resp.status_code == 200 and resp.content:
                b64 = base64.b64encode(resp.content).decode("utf-8")
                mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                logger.info("HF portrait OK seed=%d size=%d bytes", _seed, len(resp.content))
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("HF portrait error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("HF portrait exception: %s", e)

    # ── Pollinations ───────────────────────────────────────────
    if POLLINATIONS_API_KEY:
        encoded = urllib.parse.quote(full_prompt)
        seed_p = _seed % 99999 + 1
        portrait_url = (
            f"https://gen.pollinations.ai/image/{encoded}"
            f"?width=512&height=512&nologo=true&seed={seed_p}&model=flux"
        )
        try:
            img_resp = await _http_client.get(
                portrait_url,
                headers={"Authorization": f"Bearer {POLLINATIONS_API_KEY}"},
                timeout=90,
                follow_redirects=True,
            )
            if img_resp.status_code == 200 and img_resp.content:
                mime = img_resp.headers.get("content-type", "image/jpeg").split(";")[0]
                if not mime.startswith("image/"):
                    mime = "image/jpeg"
                b64 = base64.b64encode(img_resp.content).decode("utf-8")
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("Pollinations portrait returned status %s", img_resp.status_code)
        except Exception as e:
            logger.warning("Pollinations portrait failed: %s", e)

    # ── Pillow fallback: simple emoji-centred placeholder ──────
    try:
        b64 = await asyncio.get_running_loop().run_in_executor(
            None, lambda: _generate_portrait_pillow(req.name, req.emoji or "👤")
        )
        return {"url": f"data:image/jpeg;base64,{b64}"}
    except Exception as e:
        logger.warning("Pillow portrait fallback failed: %s", e)

    raise HTTPException(status_code=502, detail="肖像生成失敗，請稍後再試")


def _generate_portrait_pillow(name: str, emoji: str) -> str:
    """Minimal Pillow portrait: solid gradient background + large emoji + name label."""
    from PIL import Image, ImageDraw, ImageFont  # type: ignore
    size = 512
    img = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(img)

    # Soft radial-ish gradient background using two blended solid fills
    for y in range(size):
        t = y / size
        r = int(180 + 60 * t)
        g = int(200 + 40 * t)
        b = int(230 - 30 * t)
        draw.line([(0, y), (size, y)], fill=(r, g, b))

    # Large emoji / placeholder circle
    cx, cy = size // 2, size // 2 - 40
    r = 120
    draw.ellipse([(cx - r, cy - r), (cx + r, cy + r)], fill=(255, 255, 255, 220))

    # Name text at bottom
    try:
        font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 36)
        small_font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 24)
    except Exception:
        font = ImageFont.load_default()
        small_font = font

    # Draw name
    bbox = draw.textbbox((0, 0), name, font=font)
    tw = bbox[2] - bbox[0]
    draw.text(((size - tw) // 2, size - 80), name, fill=(60, 60, 80), font=font)

    # Draw emoji hint text (just the first char)
    hint = emoji[:2] if emoji else "👤"
    try:
        bbox2 = draw.textbbox((0, 0), hint, font=font)
        tw2 = bbox2[2] - bbox2[0]
        draw.text(((size - tw2) // 2, cy - 25), hint, fill=(80, 80, 100), font=font)
    except Exception:
        pass

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85, optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


# ── 端點：圖片辨識（Groq Vision → 繁體中文場景描述）────────────
IMAGE_MAX_BYTES = 4 * 1024 * 1024  # 4 MB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

# Magic-byte signatures for each MIME type we accept.
# Checked against the actual file bytes after reading, so clients cannot spoof
# the Content-Type header to bypass format restrictions.
_IMAGE_MAGIC: dict[bytes, str] = {
    b"\xff\xd8\xff":                    "image/jpeg",  # JPEG
    b"\x89PNG\r\n\x1a\n":              "image/png",   # PNG
    b"GIF87a":                          "image/gif",   # GIF 87a
    b"GIF89a":                          "image/gif",   # GIF 89a
    # WebP: "RIFF" at offset 0, "WEBP" at offset 8
}

_AUDIO_MAGIC: dict[bytes, str] = {
    b"ID3":             "audio/mpeg",  # MP3 with ID3v2 tag
    b"\xff\xfb":        "audio/mpeg",  # MP3 frame sync (MPEG1 Layer3 CBR)
    b"\xff\xf3":        "audio/mpeg",  # MP3 frame sync (MPEG1 Layer3 VBR)
    b"\xff\xfa":        "audio/mpeg",  # MP3 frame sync variant
    b"RIFF":            "audio/wav",   # WAV (RIFF container; confirmed below)
    b"\x1a\x45\xdf\xa3": "audio/webm", # WebM EBML header
}


def _detect_image_type(data: bytes) -> str | None:
    """Return the MIME type inferred from file magic bytes, or None if unknown."""
    # WebP: RIFF at [0:4] and WEBP at [8:12]
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    for magic, mime in _IMAGE_MAGIC.items():
        if data[:len(magic)] == magic:
            return mime
    return None


def _detect_audio_type(data: bytes) -> str | None:
    """Return the MIME type inferred from audio file magic bytes, or None if unknown."""
    # WAV: RIFF container + "WAVE" four-cc at offset 8
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    # M4A/MP4: ftyp box often at offset 4 (box length at [0:4], "ftyp" at [4:8])
    if len(data) >= 12 and data[4:8] == b"ftyp":
        return "audio/mp4"
    for magic, mime in _AUDIO_MAGIC.items():
        if data[:len(magic)] == magic:
            return mime
    return None

IMAGE_DESCRIBE_PROMPT = (
    "請用台灣繁體中文描述這張圖片的場景內容，100字以內，符合台灣語言習慣，適合作為兒童繪本的場景描述。"
)

@app.post("/api/recognize-image")
async def recognize_image(request: Request, file: UploadFile = File(...)):
    ip = _client_ip(request)
    if not _rl_recognize.is_allowed(ip):
        raise _rl_429(_rl_recognize, ip)
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY 未設定，服務無法使用")

    # Content-type validation
    content_type = file.content_type or ""
    if content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的圖片格式（{content_type}），請上傳 JPG、PNG、WebP 或 GIF"
        )

    # Read & size validation
    data = await file.read()
    if len(data) > IMAGE_MAX_BYTES:
        raise HTTPException(status_code=400, detail="圖片檔案超過 4MB 上限")

    # Magic-bytes validation: confirm file content matches declared MIME type.
    # This prevents clients from spoofing Content-Type to bypass format restrictions.
    detected = _detect_image_type(data)
    if detected is None:
        raise HTTPException(status_code=400, detail="檔案格式無法辨識，請上傳 JPG、PNG、WebP 或 GIF 圖片")
    if detected not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=400, detail=f"不支援此圖片格式（{detected}），請上傳 JPG、PNG、WebP 或 GIF")
    # Use the detected type (not the client-supplied one) so the data URI is always correct
    content_type = detected

    # Encode to base64 data URI
    b64 = base64.b64encode(data).decode("utf-8")
    image_url = f"data:{content_type};base64,{b64}"

    payload = {
        "model": "meta-llama/llama-4-scout-17b-16e-instruct",
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": IMAGE_DESCRIBE_PROMPT},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ],
            }
        ],
        "max_tokens": 300,
        "temperature": 0.5,
    }

    try:
        resp = await _http_client.post(
            GROQ_CHAT_URL,
            headers={
                "Authorization": f"Bearer {GROQ_API_KEY}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=60,
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="圖片辨識逾時，請稍後重試")
    except httpx.RequestError as e:
        logger.error("Groq vision request error: %s", e)
        raise HTTPException(status_code=502, detail="無法連線至圖片辨識服務，請稍後重試")

    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="API 額度不足，請稍後重試")
    if resp.status_code != 200:
        logger.error("Groq vision error %s: %s", resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail="圖片辨識服務暫時無法使用，請稍後重試")

    try:
        description = resp.json()["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        raise HTTPException(status_code=502, detail="圖片辨識回應格式異常")

    return {"description": description.strip()}


# ── 端點：語音轉文字（Groq Whisper → 繁體中文）──────────────────
AUDIO_MAX_BYTES = 25 * 1024 * 1024  # 25 MB
ALLOWED_AUDIO_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/wave",
    "audio/x-wav", "audio/mp4", "audio/m4a", "audio/x-m4a",
    "audio/webm", "video/webm",
}

GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

@app.post("/api/transcribe")
async def transcribe_audio(request: Request, file: UploadFile = File(...)):
    ip = _client_ip(request)
    if not _rl_transcribe.is_allowed(ip):
        raise _rl_429(_rl_transcribe, ip)
    if not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="GROQ_API_KEY 未設定，服務無法使用")

    content_type = file.content_type or ""
    if content_type not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"不支援的音訊格式（{content_type}），請上傳 MP3、WAV、M4A 或 WebM"
        )

    data = await file.read()
    if len(data) > AUDIO_MAX_BYTES:
        raise HTTPException(status_code=400, detail="音訊檔案超過 25MB 上限")

    # Magic-bytes validation: confirm file content matches declared MIME type.
    # Browsers sometimes send "audio/webm" for M4A or misreport the format;
    # use the detected type so Groq Whisper receives the correct Content-Type.
    detected_audio = _detect_audio_type(data)
    if detected_audio is None:
        raise HTTPException(status_code=400, detail="音訊格式無法辨識，請上傳 MP3、WAV、M4A 或 WebM 檔案")
    if detected_audio not in ALLOWED_AUDIO_TYPES:
        raise HTTPException(status_code=400, detail=f"不支援此音訊格式（{detected_audio}），請上傳 MP3、WAV、M4A 或 WebM")
    content_type = detected_audio

    # Determine a safe filename extension for the multipart upload
    _ext_map = {
        "audio/mpeg": "mp3", "audio/wav": "wav",
        "audio/mp4": "m4a", "audio/webm": "webm",
    }
    _safe_ext = _ext_map.get(content_type, "webm")
    filename = file.filename or f"audio.{_safe_ext}"

    try:
        resp = await _http_client.post(
            GROQ_TRANSCRIBE_URL,
            headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
            files={"file": (filename, data, content_type)},
            data={
                "model": "whisper-large-v3-turbo",
                "language": "zh",
                "response_format": "json",
            },
            timeout=120,
        )
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="語音辨識逾時，請稍後重試")
    except httpx.RequestError as e:
        logger.error("Groq whisper request error: %s", e)
        raise HTTPException(status_code=502, detail="無法連線至語音辨識服務，請稍後重試")

    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="API 額度不足，請稍後重試")
    if resp.status_code != 200:
        logger.error("Groq whisper error %s: %s", resp.status_code, resp.text[:300])
        raise HTTPException(status_code=502, detail="語音辨識服務暫時無法使用，請稍後重試")

    try:
        text = resp.json()["text"]
    except (KeyError, TypeError):
        raise HTTPException(status_code=502, detail="語音辨識回應格式異常")

    return {"text": text.strip()}


# ── Project persistence models ────────────────────────────────
class CreateProjectRequest(BaseModel):
    name: str = Field("未命名作品", max_length=100)

class RenameProjectRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)

class SceneLineIn(BaseModel):
    """Typed representation of a single dialogue line stored in a scene."""
    # Stable client-side ID assigned when the line is first created.
    # Persisted to the DB so IDs survive save/reload cycles and allow the
    # preserve_blobs audio merge to match by identity rather than position.
    id: Optional[str] = Field(None, max_length=20)
    character_id: str = Field("", max_length=64)
    character_name: str = Field("", max_length=30)
    voice_id: str = Field("", max_length=64)
    text: str = Field("", max_length=200)
    emotion: Optional[str] = Field("neutral", max_length=20)
    # audio_base64 may be a large data URI; cap at ~6 MB encoded (≈ 4.5 MB raw)
    audio_base64: Optional[str] = Field(None, max_length=6_000_000)
    audio_format: Optional[str] = Field(None, max_length=10)

    @field_validator("emotion", mode="before")
    @classmethod
    def _normalise_emotion(cls, v: object) -> str:
        """Accept only known emotion values; coerce unknown strings to "neutral".

        Defense-in-depth: _EMOTION_PROSODY uses .get() with a "neutral" fallback
        at render time, but validating here ensures arbitrary strings are never
        persisted to the database and that stored values always match a known
        prosody entry.
        """
        if v is None:
            return "neutral"
        s = str(v).lower().strip()
        return s if s in VALID_EMOTIONS else "neutral"

    @field_validator("audio_format", mode="before")
    @classmethod
    def _normalise_audio_format(cls, v: object) -> Optional[str]:
        """Accept only "mp3" or "wav"; coerce everything else to None.

        The value is stripped to alphanumeric characters and lower-cased before
        the whitelist check.  This mirrors the sanitisation applied at render
        time in all export functions (_export_html, _export_epub,
        _export_mp3_zip) and prevents arbitrary strings from being persisted
        and later embedded in HTML/EPUB/ZIP output.
        """
        if v is None:
            return None
        clean = re.sub(r"[^a-z0-9]", "", str(v).lower())
        return clean if clean in ("mp3", "wav") else None

    @field_validator("voice_id", mode="before")
    @classmethod
    def _normalise_voice_id(cls, v: object) -> str:
        """Accept only known voice IDs or empty string; coerce unknown values to "".

        Defense-in-depth: prevents arbitrary voice_id strings from being
        persisted to the database via SaveScenes requests.  The generate-voice
        endpoint validates voice_id at call time, but validating here ensures
        the stored value is always clean.
        """
        if v is None:
            return ""
        s = str(v)
        return s if s == "" or s in VALID_VOICE_IDS else ""

# CSS color validation + all _export_* functions live in exports.py (~1700 lines).
from exports import _SAFE_CSS_COLOR_RE, _safe_css_color  # noqa: E402
from exports import (  # noqa: E402
    _export_pdf, _export_epub, _export_html, _export_mp3_zip,
    _export_txt, _export_srt, _export_md, _export_images_zip,
    _export_json_backup,
)


class CharacterIn(BaseModel):
    """Character definition stored alongside a project."""
    id: str = Field("", max_length=64)
    name: str = Field("", max_length=30)
    personality: str = Field("", max_length=100)
    visual_description: str = Field("", max_length=200)
    voice_id: str = Field("", max_length=64)
    color: str = Field("", max_length=20)
    emoji: str = Field("", max_length=10)
    # AI-generated portrait stored as a base64 data URI.  No max_length here
    # because portraits can reach ~150 KB encoded; the DB column is JSONB (no row
    # limit beyond the 1 GB page size), so truncating would corrupt the image.
    portrait_url: Optional[str] = None

    @field_validator("color", mode="before")
    @classmethod
    def _normalise_color(cls, v: object) -> str:
        """Accept only CSS hex colors or empty string; coerce invalid values to "".

        Defense-in-depth: _safe_css_color() validates the value at render/export
        time, but validating here ensures the stored DB value is always a well-formed
        hex color (or empty).  Prevents arbitrary strings from being persisted even
        if future export paths forget to call _safe_css_color().
        """
        if v is None:
            return ""
        s = str(v)
        return s if s == "" or _SAFE_CSS_COLOR_RE.match(s) else ""

    @field_validator("voice_id", mode="before")
    @classmethod
    def _normalise_voice_id(cls, v: object) -> str:
        """Accept only known voice IDs or empty string; coerce unknown values to "".

        Defense-in-depth: mirrors the validator on SceneLineIn.voice_id so that
        any voice_id stored alongside a project character is always a known
        value (or empty).
        """
        if v is None:
            return ""
        s = str(v)
        return s if s == "" or s in VALID_VOICE_IDS else ""

class SceneIn(BaseModel):
    idx: int = Field(..., ge=0, le=999)
    title: str = Field("", max_length=100)
    description: str = Field("", max_length=500)
    style: str = Field("溫馨童趣", max_length=20)
    line_length: str = Field("standard", max_length=20)
    # Image style used when the scene was generated; persisted so regeneration
    # can default back to the same style rather than the current global setting.
    image_style: str = Field("", max_length=100)
    # Mood / age_group used when the script was generated; persisted so the
    # per-scene regeneration form can pre-fill the original settings.
    mood: str = Field("", max_length=20)
    age_group: str = Field("child", max_length=20)
    # Private director/author notes — stored in DB but never included in exports
    notes: str = Field("", max_length=2000)
    script: Dict[str, Any] = {}
    lines: List[SceneLineIn] = Field(default_factory=list, max_length=50)
    # base64-encoded image: cap at ~6 MB of encoded data (≈ 4.5 MB raw)
    image: str = Field("", max_length=6_000_000)
    # When True the frontend omitted image/audio from this scene because they
    # have not changed since the last save.  The backend reads the existing
    # blobs from the DB and merges them in before writing.
    preserve_blobs: bool = False
    # When True the scene is protected from batch/accidental regeneration
    is_locked: bool = False

    @field_validator("line_length", mode="before")
    @classmethod
    def _normalise_line_length(cls, v: object) -> str:
        """Coerce unknown line_length values to 'standard'.
        Defense-in-depth: GenerateScriptRequest already uses Literal for this
        field, but SceneIn (used by SaveScenes) must also reject arbitrary strings
        so the stored DB value is always one of 'short', 'standard', 'long'.
        """
        _VALID = {"short", "standard", "long"}
        if v is None:
            return "standard"
        s = str(v)
        return s if s in _VALID else "standard"

class SaveScenesRequest(BaseModel):
    scenes: Annotated[List[SceneIn], Field(max_length=100)]
    characters: List[CharacterIn] = Field(default_factory=list, max_length=20)


def _db_required():
    if _db_pool is None:
        raise HTTPException(status_code=503, detail="資料庫未連線，專案功能暫時無法使用")


def _validate_uuid(value: str) -> str:
    """Raise HTTP 400 if *value* is not a valid UUID; return it unchanged."""
    try:
        uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=400, detail="無效的專案 ID 格式")
    return value


# ── GET /api/projects ─────────────────────────────────────────
@app.get("/api/projects")
async def list_projects(request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH top_projects AS (
                SELECT id, name, created_at, updated_at, cover_image
                FROM projects
                ORDER BY updated_at DESC
                LIMIT 200
            )
            SELECT p.id, p.name, p.created_at, p.updated_at, p.cover_image,
                   COALESCE(ss.scene_count, 0)::int AS scene_count,
                   COALESCE(ss.line_count,  0)::int AS line_count,
                   COALESCE(ss.total_chars, 0)::int AS total_chars
            FROM top_projects p
            LEFT JOIN (
                SELECT
                    project_id,
                    COUNT(*)::int                                              AS scene_count,
                    COALESCE(SUM(jsonb_array_length(lines)), 0)::int          AS line_count,
                    COALESCE(SUM((
                        SELECT COALESCE(SUM(length(l->>'text')), 0)
                        FROM jsonb_array_elements(lines) AS l
                    )), 0)::int                                                AS total_chars
                FROM scenes
                WHERE project_id IN (SELECT id FROM top_projects)
                GROUP BY project_id
            ) ss ON ss.project_id = p.id
            ORDER BY p.updated_at DESC
            """
        )
    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "created_at": r["created_at"].isoformat(),
            "updated_at": r["updated_at"].isoformat(),
            "scene_count": r["scene_count"],
            "line_count": r["line_count"],
            "total_chars": r["total_chars"],
            "cover_image": r["cover_image"],
        }
        for r in rows
    ]


# ── POST /api/projects ────────────────────────────────────────
@app.post("/api/projects", status_code=201)
async def create_project(req: CreateProjectRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO projects (name) VALUES ($1) RETURNING id, name, created_at, updated_at",
            req.name,
        )
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


# ── POST /api/projects/import-json ───────────────────────────
class ImportJsonRequest(BaseModel):
    """Payload for restoring a project from a JSON backup file."""
    name:       str            = Field("未命名匯入作品", max_length=100)
    characters: List[Any]     = Field(default_factory=list, max_length=20)
    scenes:     List[Any]     = Field(default_factory=list, max_length=50)


_DEFAULT_VOICE = "cn-natural-female"


@app.post("/api/projects/import-json", status_code=201)
async def import_project_json(req: ImportJsonRequest, request: Request):
    """Restore a project from a JSON backup (exported by /api/projects/{id}/export?format=json).

    No media blobs (audio / image) are expected or stored — only the text structure.
    Voice IDs not in the known set are silently replaced with the default voice.
    """
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()

    # ── Sanitize characters ───────────────────────────────────────
    clean_chars: list[dict] = []
    for c in req.characters[:20]:
        if not isinstance(c, dict):
            continue
        voice_id = str(c.get("voice_id") or _DEFAULT_VOICE)
        if voice_id not in VALID_VOICE_IDS:
            voice_id = _DEFAULT_VOICE
        color_raw = str(c.get("color") or "#667eea")
        # Only accept CSS hex colors (reuse the compiled pattern, not a duplicate regex)
        color = color_raw if _SAFE_CSS_COLOR_RE.match(color_raw) else "#667eea"
        clean_chars.append({
            "id":               str(c.get("id") or "")[:64] or f"char_{uuid.uuid4().hex[:8]}",
            "name":             str(c.get("name") or "角色")[:30] or "角色",
            "personality":      str(c.get("personality") or "")[:100],
            "visual_description": str(c.get("visual_description") or "")[:200],
            "voice_id":         voice_id,
            "color":            color,
            "emoji":            str(c.get("emoji") or "🎭")[:10],
        })

    # ── Sanitize scenes ───────────────────────────────────────────
    scene_rows: list[tuple] = []
    for i, s in enumerate(req.scenes[:50]):
        if not isinstance(s, dict):
            continue
        raw_lines = s.get("lines") or []
        clean_lines: list[dict] = []
        for ln in raw_lines[:50]:
            if not isinstance(ln, dict):
                continue
            text = str(ln.get("text") or "").strip()[:200]
            if not text:
                continue
            emotion = str(ln.get("emotion") or "neutral")
            if emotion not in VALID_EMOTIONS:
                emotion = "neutral"
            v_id = str(ln.get("voice_id") or _DEFAULT_VOICE)
            if v_id not in VALID_VOICE_IDS:
                v_id = _DEFAULT_VOICE
            clean_lines.append({
                "character_name": str(ln.get("character_name") or "")[:30],
                "character_id":   str(ln.get("character_id") or "")[:64],
                "voice_id":       v_id,
                "text":           text,
                "emotion":        emotion,
            })
        script = {
            "lines":           clean_lines,
            "scene_prompt":    str(s.get("scene_prompt") or "")[:1000],
            "sfx_description": str(s.get("sfx_description") or "")[:200],
            "scene_title":     str(s.get("title") or "")[:20],
        }
        ll = str(s.get("line_length") or "standard")
        if ll not in ("short", "standard", "long"):
            ll = "standard"
        # Use the exported idx directly when present; fall back to the loop
        # counter (0-based).  Must NOT use `s.get("idx") or fallback` because
        # idx=0 (the first scene) is falsy in Python — that pattern would
        # silently replace 0 with 1, collide with the second scene (also idx=1),
        # and trigger the UNIQUE(project_id, idx) constraint on every import of
        # a project with 2+ scenes.
        raw_idx = s.get("idx")
        scene_idx = int(raw_idx) if raw_idx is not None else i
        age_grp = str(s.get("age_group") or "child")[:20]
        if age_grp not in ("toddler", "child", "preteen"):
            age_grp = "child"
        scene_rows.append((
            scene_idx,
            str(s.get("title") or "")[:100],
            str(s.get("description") or "")[:500],
            str(s.get("style") or "溫馨童趣")[:20],
            ll,
            str(s.get("image_style") or "")[:100],   # preserve if present in backup
            str(s.get("mood") or "")[:20],
            age_grp,
            str(s.get("notes") or "")[:2000],
            json.dumps(script, ensure_ascii=False),
            json.dumps(clean_lines, ensure_ascii=False),
            "",     # image: intentionally empty — user regenerates after import
            bool(s.get("is_locked", False)),
        ))

    # ── Persist atomically: project + scenes in ONE transaction ──────
    # The project INSERT must be inside the same transaction as the scene
    # INSERTs.  Previously the project row was created outside the inner
    # transaction, so a scene insertion failure (e.g. duplicate idx) would
    # leave an orphaned project row in the database.
    # mirrors the pattern used by duplicate_project.
    async with _db_pool.acquire() as conn:
        project_name = req.name.strip() or "未命名匯入作品"
        async with conn.transaction():
            row = await conn.fetchrow(
                """
                INSERT INTO projects (name, characters)
                VALUES ($1, $2::jsonb)
                RETURNING id, name, created_at, updated_at
                """,
                project_name,
                json.dumps(clean_chars, ensure_ascii=False),
            )
            project_id = str(row["id"])

            if scene_rows:
                await conn.executemany(
                    """
                    INSERT INTO scenes
                      (project_id, idx, title, description, style, line_length, image_style, mood, age_group, notes, script, lines, image, is_locked)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
                    """,
                    [(project_id, *r) for r in scene_rows],
                )

    logger.info(
        "import-json project_id=%s name=%r chars=%d scenes=%d",
        project_id, project_name, len(clean_chars), len(scene_rows),
    )
    return {
        "id":         project_id,
        "name":       project_name,
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


# ── POST /api/projects/{project_id}/duplicate ─────────────────
@app.post("/api/projects/{project_id}/duplicate", status_code=201)
async def duplicate_project(project_id: str, request: Request):
    """Deep-copy a project: all scenes, characters, images, and cover thumbnail."""
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)

    def _to_json(v: Any) -> str:
        return v if isinstance(v, str) else json.dumps(v or [], ensure_ascii=False)

    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT name, characters, cover_image FROM projects WHERE id = $1",
            project_id,
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")

        scene_rows = await conn.fetch(
            "SELECT idx, title, description, style, line_length, image_style, mood, age_group, notes, is_locked, script, lines, image "
            "FROM scenes WHERE project_id = $1 ORDER BY idx",
            project_id,
        )

        new_name = f"副本 - {proj['name']}"[:100]

        async with conn.transaction():
            new_proj = await conn.fetchrow(
                """
                INSERT INTO projects (name, characters, cover_image)
                VALUES ($1, $2::jsonb, $3)
                RETURNING id, name, created_at, updated_at
                """,
                new_name,
                _to_json(proj["characters"]),
                proj["cover_image"],
            )
            new_id = new_proj["id"]

            if scene_rows:
                await conn.executemany(
                    """
                    INSERT INTO scenes
                      (project_id, idx, title, description, style, line_length, image_style, mood, age_group, notes, is_locked, script, lines, image)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14)
                    """,
                    [
                        (
                            new_id,
                            row["idx"],
                            row.get("title", ""),
                            row["description"],
                            row["style"],
                            row["line_length"] or "standard",
                            row.get("image_style") or "",
                            row.get("mood") or "",
                            row.get("age_group") or "child",
                            row.get("notes") or "",
                            row.get("is_locked") or False,
                            _to_json(row["script"]),
                            _to_json(row["lines"]),
                            row["image"],
                        )
                        for row in scene_rows
                    ],
                )

    return {
        "id": str(new_proj["id"]),
        "name": new_name,
        "created_at": new_proj["created_at"].isoformat(),
        "updated_at": new_proj["updated_at"].isoformat(),
    }


# ── GET /api/projects/{project_id} ───────────────────────────
@app.get("/api/projects/{project_id}")
async def get_project(project_id: str, request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)

    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id, name, characters, created_at, updated_at FROM projects WHERE id = $1",
            project_id,
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")

        # ── ETag-based caching ──────────────────────────────────────────────
        # Project payloads can be many MB (embedded audio base64 + images).
        # The ETag is derived from `updated_at` (authoritative — always the DB
        # value, not the client's clock).  Cache-Control: no-cache instructs the
        # browser to cache the response but always revalidate with If-None-Match
        # before reuse.  On a hit the browser transparently returns the cached
        # 200 body to JavaScript, so no frontend code changes are needed.
        #
        # On ETag match: return 304 after just 1 DB query (no scenes SELECT).
        # On ETag miss:  fall through to the scenes SELECT (2 queries total —
        #                same as before this change).
        etag = f'"{proj["updated_at"].isoformat()}"'
        if request.headers.get("If-None-Match") == etag:
            return Response(
                status_code=304,
                headers={"ETag": etag, "Cache-Control": "no-cache"},
            )

        scenes = await conn.fetch(
            "SELECT id, idx, title, description, style, line_length, image_style, mood, age_group, script, lines, image, notes, is_locked FROM scenes WHERE project_id = $1 ORDER BY idx",
            project_id,
        )

    raw_chars = proj["characters"]
    characters = json.loads(raw_chars) if isinstance(raw_chars, str) else (raw_chars or [])
    body = {
        "id": str(proj["id"]),
        "name": proj["name"],
        "characters": characters,
        "created_at": proj["created_at"].isoformat(),
        "updated_at": proj["updated_at"].isoformat(),
        "scenes": [
            {
                "id": str(s["id"]),
                "idx": s["idx"],
                "title": s["title"] or "",
                "description": s["description"],
                "style": s["style"],
                "line_length": s["line_length"] or "standard",
                "image_style": s["image_style"] or "",
                "mood":        s["mood"] or "",
                "age_group":   s["age_group"] or "child",
                "script": json.loads(s["script"]) if isinstance(s["script"], str) else s["script"],
                "lines": json.loads(s["lines"]) if isinstance(s["lines"], str) else s["lines"],
                "image": s["image"],
                "notes": s["notes"] or "",
                "is_locked": bool(s["is_locked"]),
            }
            for s in scenes
        ],
    }
    return JSONResponse(
        content=body,
        headers={"ETag": etag, "Cache-Control": "no-cache"},
    )


# ── PUT /api/projects/{project_id}/characters ────────────────
class SaveCharactersRequest(BaseModel):
    characters: List[CharacterIn] = Field(default_factory=list, max_length=20)

@app.put("/api/projects/{project_id}/characters")
async def save_project_characters(project_id: str, req: SaveCharactersRequest, request: Request):
    """Persist just the characters list for a project (lightweight, no scene touch)."""
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        # Combine existence check + update into a single round-trip with RETURNING.
        # Mirrors the pattern used by rename_project; avoids a separate SELECT query.
        row = await conn.fetchrow(
            "UPDATE projects SET characters = $1::jsonb, updated_at = NOW() WHERE id = $2 RETURNING id",
            json.dumps([c.model_dump() for c in req.characters], ensure_ascii=False),
            project_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="專案不存在")
    return {"ok": True}


# ── PATCH /api/projects/{project_id} ─────────────────────────
@app.patch("/api/projects/{project_id}")
async def rename_project(project_id: str, req: RenameProjectRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE projects SET name = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, created_at, updated_at
            """,
            req.name,
            project_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="專案不存在")
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "created_at": row["created_at"].isoformat(),
        "updated_at": row["updated_at"].isoformat(),
    }


# ── DELETE /api/projects/{project_id} ────────────────────────
@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: str, request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM projects WHERE id = $1", project_id
        )
        if result == "DELETE 0":
            raise HTTPException(status_code=404, detail="專案不存在")
    return {"ok": True}


# ── PUT /api/projects/{project_id}/scenes ────────────────────
@app.put("/api/projects/{project_id}/scenes")
async def save_scenes(project_id: str, req: SaveScenesRequest, request: Request):
    ip = _client_ip(request)
    if not _rl_project.is_allowed(ip):
        raise _rl_429(_rl_project, ip)
    _db_required()
    _validate_uuid(project_id)

    # Fetch existing blobs (image + lines audio) for scenes where the frontend
    # flagged preserve_blobs=True.  This avoids re-uploading large base64 payloads
    # on every keystroke while still keeping audio/image data intact in the DB.
    # We do the SELECT outside the write transaction so we hold the connection
    # for as short a time as possible.
    preserve_idxs = [s.idx for s in req.scenes if s.preserve_blobs]
    existing_blobs: dict[int, dict] = {}
    if preserve_idxs:
        async with _db_pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT idx, image, lines
                FROM scenes
                WHERE project_id = $1 AND idx = ANY($2::smallint[])
                """,
                project_id, preserve_idxs,
            )
            for row in rows:
                existing_blobs[row["idx"]] = {
                    "image": row["image"],
                    "lines": json.loads(row["lines"]),
                }

    # ── Preserve character portrait_url values stripped by the frontend ─────
    # App.tsx strips portrait_url from the _flushSave (autosave) payload to cut
    # payload size from ~600 KB (6 chars × 100 KB portrait) down to ~5 KB.
    # Portraits are separately persisted by PUT /projects/{id}/characters.
    # Without this merge, every autosave would overwrite the characters column
    # with portrait_url=null, erasing all AI-generated portrait images.
    existing_portrait_map: dict[str, str] = {}
    if req.characters and any(c.portrait_url is None for c in req.characters):
        async with _db_pool.acquire() as conn:
            proj_row = await conn.fetchrow(
                "SELECT characters FROM projects WHERE id = $1", project_id
            )
            if proj_row:
                raw_existing = proj_row["characters"] or []
                if isinstance(raw_existing, str):
                    raw_existing = json.loads(raw_existing)
                for ch in raw_existing:
                    cid = ch.get("id", "")
                    portrait = ch.get("portrait_url", "")
                    if cid and portrait:
                        existing_portrait_map[cid] = portrait

    def _char_dict(c: CharacterIn) -> dict:
        """Serialize a character, restoring its portrait from the DB when the
        frontend omitted it (payload-size optimisation in _flushSave)."""
        d = c.model_dump()
        if not d.get("portrait_url") and d.get("id") in existing_portrait_map:
            d["portrait_url"] = existing_portrait_map[d["id"]]
        return d

    # Build the final rows to INSERT, merging preserved blobs from the DB.
    def _resolve_scene(scene: SceneIn) -> tuple:
        if scene.preserve_blobs and scene.idx in existing_blobs:
            ex = existing_blobs[scene.idx]
            image = ex["image"]
            ex_lines: list[dict] = ex["lines"]
            # Build an ID-based lookup for robust audio merge.
            # Lines with a stable `id` are matched by identity; lines without
            # an id (legacy DB records saved before this field was added) fall
            # back to the previous positional merge.
            ex_by_id: dict[str, dict] = {
                ln["id"]: ln for ln in ex_lines if ln.get("id")
            }
            merged: list[dict] = []
            for i, ln in enumerate(scene.lines):
                ld = ln.model_dump()
                if not ld.get("audio_base64"):
                    line_id = ld.get("id")
                    # Prefer ID match (stable); fall back to position for legacy rows
                    ex_ln = ex_by_id.get(line_id) if line_id else None
                    if ex_ln is None and i < len(ex_lines):
                        ex_ln = ex_lines[i]
                    if ex_ln:
                        ld["audio_base64"] = ex_ln.get("audio_base64")
                        ld["audio_format"] = ex_ln.get("audio_format")
                merged.append(ld)
        else:
            image = scene.image
            merged = [ln.model_dump() for ln in scene.lines]
        return (
            project_id,
            scene.idx,
            scene.title,
            scene.description,
            scene.style,
            scene.line_length or "standard",
            scene.image_style or "",
            scene.mood or "",
            scene.age_group or "child",
            json.dumps(scene.script, ensure_ascii=False),
            json.dumps(merged, ensure_ascii=False),
            image,
            scene.notes,
            scene.is_locked,
        )

    resolved = [_resolve_scene(s) for s in req.scenes]

    # Cover thumbnail is always derived from scene idx=0 (the opening scene).
    # Only recompute when scene 0 carries a freshly-uploaded image (preserve_blobs=False);
    # if scene 0 is unchanged the existing cover_image is kept via COALESCE below.
    # Previously we used the first *any* new image, which caused the cover to flip to
    # a later scene whenever that scene was regenerated while scene 0 stayed the same.
    # CPU-bound; done before acquiring the write connection to keep the transaction short.
    # Prefer scene 0's image for the cover; fall back to the first scene that has one.
    # This ensures the project list always shows a thumbnail as soon as ANY scene has an image,
    # even if the user generated scenes out of order.
    cover_thumb: str | None = None
    sorted_scenes = sorted(req.scenes, key=lambda s: s.idx)
    cover_scene = next(
        (s for s in sorted_scenes
         if not s.preserve_blobs and s.image and s.image not in ("", "error")),
        None,
    )
    if cover_scene is not None:
        cover_thumb = await asyncio.get_running_loop().run_in_executor(
            None, _make_cover_thumbnail, cover_scene.image
        )

    # Indexes of scenes being saved — used to prune any scenes the user deleted.
    saved_idxs = [r[1] for r in resolved]  # r[1] is the `idx` positional field

    async with _db_pool.acquire() as conn:
        async with conn.transaction():
            if resolved:
                # UPSERT: insert new scenes or update existing ones in-place.
                # The UNIQUE(project_id, idx) constraint enables ON CONFLICT.
                # Rows that already exist are updated rather than deleted and
                # re-inserted, which avoids unnecessary JSONB blob churn (audio
                # base64 + scene image) for scenes that haven't changed.
                # FK constraint on project_id fires here if the project was deleted
                # between the request arriving and the transaction starting.
                try:
                    await conn.executemany(
                        """
                        INSERT INTO scenes (project_id, idx, title, description, style, line_length, image_style, mood, age_group, script, lines, image, notes, is_locked)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14)
                        ON CONFLICT (project_id, idx) DO UPDATE SET
                          title       = EXCLUDED.title,
                          description = EXCLUDED.description,
                          style       = EXCLUDED.style,
                          line_length = EXCLUDED.line_length,
                          image_style = EXCLUDED.image_style,
                          mood        = EXCLUDED.mood,
                          age_group   = EXCLUDED.age_group,
                          script      = EXCLUDED.script,
                          lines       = EXCLUDED.lines,
                          image       = EXCLUDED.image,
                          notes       = EXCLUDED.notes,
                          is_locked   = EXCLUDED.is_locked
                        """,
                        resolved,
                    )
                except Exception as exc:
                    if _asyncpg_available and isinstance(
                        exc, asyncpg.exceptions.ForeignKeyViolationError
                    ):
                        raise HTTPException(status_code=404, detail="專案不存在") from exc
                    raise
            # Prune scenes that were removed on the client side.
            # When saved_idxs is empty (all scenes deleted) this removes every
            # scene for the project; otherwise only the missing indexes are pruned.
            await conn.execute(
                "DELETE FROM scenes WHERE project_id = $1 AND idx != ALL($2::smallint[])",
                project_id,
                saved_idxs,
            )
            # COALESCE keeps the existing cover when no new image was uploaded
            # (e.g. pure text edit — all scenes had preserve_blobs=True).
            # RETURNING id doubles as the project-existence check — if no row
            # is returned the project was deleted and we raise 404 after the
            # transaction commits (it only deleted orphaned scenes, so no harm).
            updated = await conn.fetchrow(
                """
                UPDATE projects
                SET updated_at = NOW(),
                    characters = $1::jsonb,
                    cover_image = COALESCE($3, cover_image)
                WHERE id = $2
                RETURNING id
                """,
                json.dumps([_char_dict(c) for c in req.characters], ensure_ascii=False),
                project_id,
                cover_thumb,
            )
    if updated is None:
        raise HTTPException(status_code=404, detail="專案不存在")
    return {"ok": True}



def _make_cover_thumbnail(image_data: str, width: int = 240, height: int = 180) -> str | None:
    """Resize a scene image to a small JPEG thumbnail for the project list.

    Accepts either a data URI (``data:image/...;base64,...``) or a plain
    base64 string. Returns a data URI string, or None on any failure.
    """
    if not image_data or image_data == "error":
        return None
    try:
        from PIL import Image  # type: ignore
        # Decode base64 payload
        if image_data.startswith("data:"):
            header, b64 = image_data.split(",", 1)
            raw = base64.b64decode(b64)
        else:
            raw = base64.b64decode(image_data)
        img = Image.open(io.BytesIO(raw)).convert("RGB")
        img.thumbnail((width, height), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=70, optimize=True)
        thumb_b64 = base64.b64encode(buf.getvalue()).decode()
        return f"data:image/jpeg;base64,{thumb_b64}"
    except Exception:
        return None



# ── GET /api/projects/{project_id}/export ────────────────────
_EXPORT_FORMAT = Literal["pdf", "epub", "html", "mp3", "txt", "md", "images", "json", "srt"]

@app.get("/api/projects/{project_id}/export")
async def export_project(
    request: Request,
    project_id: str,
    format: _EXPORT_FORMAT = "pdf",
    inline: bool = False,
):
    ip = _client_ip(request)
    if not _rl_export.is_allowed(ip):
        raise _rl_429(_rl_export, ip, "匯出請求過於頻繁，請稍後再試")
    _db_required()
    _validate_uuid(project_id)

    # Load project from DB.
    # Only fetch the `image` column for formats that actually embed illustrations.
    # For text-only exports (txt, md, json, mp3) the image column can be hundreds of
    # KB of base64 per scene and is immediately discarded — skip it to cut DB payload.
    _FORMATS_NEED_IMAGE = frozenset({"pdf", "epub", "html", "images"})
    _image_col = "image" if format in _FORMATS_NEED_IMAGE else "'' AS image"
    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id, name, characters FROM projects WHERE id = $1", project_id
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")
        scene_rows = await conn.fetch(
            f"SELECT idx, title, description, style, line_length, image_style, mood, age_group, is_locked, notes, script, lines, {_image_col} FROM scenes "
            "WHERE project_id = $1 ORDER BY idx",
            project_id,
        )

    project_name = proj["name"]

    # Build name→color map for per-character accent colours in exports.
    # Guard json.loads against corrupted rows (e.g. partial writes or schema migration artifacts).
    try:
        raw_chars = proj["characters"] or []
        if isinstance(raw_chars, str):
            raw_chars = json.loads(raw_chars)
    except (json.JSONDecodeError, TypeError):
        raw_chars = []
    char_color_map: dict[str, str] = {
        c.get("name", ""): c.get("color", "")
        for c in raw_chars
        if c.get("name")
    }

    scenes = []
    for row in scene_rows:
        try:
            raw_lines = row["lines"]
            if isinstance(raw_lines, str):
                raw_lines = json.loads(raw_lines)
        except (json.JSONDecodeError, TypeError):
            raw_lines = []
        try:
            raw_script = row["script"] or {}
            if isinstance(raw_script, str):
                raw_script = json.loads(raw_script)
        except (json.JSONDecodeError, TypeError):
            raw_script = {}
        scenes.append({
            "idx":             row["idx"],
            "title":           row["title"] or "",
            "description":     row["description"],
            "style":           row["style"],
            "line_length":     row["line_length"] or "standard",
            "image_style":     row["image_style"] or "",
            "mood":            row["mood"] or "",
            "age_group":       row["age_group"] or "child",
            "is_locked":       bool(row["is_locked"]),
            "notes":           row["notes"] or "",
            "scene_prompt":    raw_script.get("scene_prompt", ""),
            "sfx_description": raw_script.get("sfx_description", ""),
            "lines":           raw_lines,
            "image":           row["image"],
        })

    # Run CPU-bound export functions in a thread pool to avoid blocking
    # the async event loop (PDF rendering / EPUB serialisation can take >1 s).
    # asyncio.wait_for() enforces a hard ceiling so a hung renderer cannot
    # exhaust thread-pool resources or leave the client waiting indefinitely.
    _EXPORT_TIMEOUT_SECS = 300  # 5 minutes — generous for large PDF/EPUB
    loop = asyncio.get_running_loop()
    try:
        if format == "pdf":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_pdf, project_name, scenes, char_color_map, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "application/pdf"
            filename = f"{project_name}.pdf"
        elif format == "epub":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_epub, project_name, scenes, char_color_map, project_id, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "application/epub+zip"
            filename = f"{project_name}.epub"
        elif format == "html":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_html, project_name, scenes, char_color_map, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "text/html; charset=utf-8"
            filename = f"{project_name}.html"
        elif format == "mp3":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_mp3_zip, project_name, scenes),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "application/zip"
            filename = f"{project_name}_audio.zip"
        elif format == "md":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_md, project_name, scenes, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "text/markdown; charset=utf-8"
            filename = f"{project_name}.md"
        elif format == "images":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_images_zip, project_name, scenes),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "application/zip"
            filename = f"{project_name}_插圖.zip"
        elif format == "json":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_json_backup, project_name, scenes, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "application/json; charset=utf-8"
            filename = f"{project_name}_備份.json"
        elif format == "srt":
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_srt, project_name, scenes),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "text/srt; charset=utf-8"
            filename = f"{project_name}_字幕.srt"
        else:  # "txt"
            data = await asyncio.wait_for(
                loop.run_in_executor(None, _export_txt, project_name, scenes, raw_chars),
                timeout=_EXPORT_TIMEOUT_SECS,
            )
            media_type = "text/plain; charset=utf-8"
            filename = f"{project_name}_劇本.txt"
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=504,
            detail=f"匯出逾時（{format} 格式處理時間過長），請縮短作品長度或稍後再試",
        )
    except Exception as exc:
        logger.error("Export %s failed for project %s: %s", format, project_id, exc, exc_info=True)
        raise HTTPException(
            status_code=502,
            detail=f"匯出失敗（{type(exc).__name__}），請重試或改用其他格式",
        )

    # URL-encode filename for Content-Disposition (RFC 5987).
    # safe='' encodes ALL characters including / (default safe='/'),
    # so project names like "小兔/冒險" don't produce a bare slash
    # that some browsers interpret as a directory separator.
    encoded_filename = urllib.parse.quote(filename, safe='')
    # `inline=True` is intended for HTML previews opened in a new browser tab;
    # the browser renders the document instead of triggering a download.
    disposition = "inline" if (inline and format == "html") else "attachment"
    headers = {
        "Content-Disposition": f"{disposition}; filename*=UTF-8''{encoded_filename}",
        "Content-Length": str(len(data)),
    }
    return StreamingResponse(io.BytesIO(data), media_type=media_type, headers=headers)


# ── 健康檢查 ──────────────────────────────────────────────────
@app.get("/api/health")
def health():
    """Return service availability without exposing key values.

    ``services`` reports which external APIs are configured so operators can
    quickly diagnose missing-key issues without grepping container logs.
    The values are booleans only — no secrets are returned.
    """
    return {
        "status": "ok",
        "services": {
            # Script / LLM generation (at least one key required)
            "llm": bool(MINIMAX_API_KEY or GROQ_API_KEY),
            "llm_minimax": bool(MINIMAX_API_KEY),
            "llm_groq": bool(GROQ_API_KEY),
            # Text-to-speech (Edge TTS is always available as final fallback)
            "tts_xfyun": bool(XFYUN_APP_ID and XFYUN_API_KEY and XFYUN_API_SECRET),
            "tts_groq": bool(GROQ_API_KEY),     # Groq also serves Orpheus TTS
            "tts_edge": True,                    # edge-tts bundled, no key needed
            # Image generation (Pillow fallback requires Pillow package)
            "image_huggingface": bool(HUGGINGFACE_API_KEY),
            "image_pollinations": bool(POLLINATIONS_API_KEY),
            "image_pillow": _PILLOW_AVAILABLE,
            # Persistence
            "database": _db_pool is not None,
        },
    }
