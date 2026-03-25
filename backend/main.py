import email.utils
import hashlib
import hmac
import html
import io
import os
import re
import json
import math
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
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Annotated, Any, Dict, Literal
from dotenv import load_dotenv

load_dotenv()

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
_rl_suggest = _RateLimiter(max_calls=15,  window_secs=60)   # Scene suggestions
_rl_title   = _RateLimiter(max_calls=15,  window_secs=60)   # Title gen
_rl_upload  = _RateLimiter(max_calls=20,  window_secs=60)   # Image/audio upload
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

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _http_client, _db_pool
    _http_client = httpx.AsyncClient()
    logger.info("Shared httpx.AsyncClient created")

    if DATABASE_URL and _asyncpg_available:
        try:
            _db_pool = await asyncpg.create_pool(DATABASE_URL, min_size=1, max_size=5)
            async with _db_pool.acquire() as conn:
                await conn.execute(_CREATE_PROJECTS)
                await conn.execute(_CREATE_SCENES)
                await conn.execute(_ALTER_PROJECTS_CHARS)
                await conn.execute(_ALTER_PROJECTS_COVER)
                await conn.execute(_ALTER_SCENES_LINE_LENGTH)
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
    allow_headers=["Content-Type"],
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

# Maps Chinese art-style names (sent from the frontend) to English equivalents
# used inside the English scene_prompt instruction sent to image generation APIs.
_IMAGE_STYLE_EN: dict[str, str] = {
    "水彩繪本": "watercolor children's book illustration",
    "粉彩卡通": "pastel cartoon illustration",
    "鉛筆素描": "pencil sketch illustration",
    "宮崎駿風": "Studio Ghibli inspired anime style",
    "3D 卡通":  "3D cartoon animation style",
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
    is_ending: Optional[bool] = False  # True → inject ending guidance into prompt
    image_style: Optional[str] = Field("watercolor children's book illustration", max_length=80)

class GenerateLine(BaseModel):
    character_id: str
    voice_id: str
    text: str

class GenerateVoiceRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=200)
    voice_id: str = Field(..., max_length=64)
    emotion: Optional[str] = Field(None, max_length=20)

    @field_validator("voice_id")
    @classmethod
    def voice_must_be_valid(cls, v: str) -> str:
        if v not in VALID_VOICE_IDS:
            raise ValueError("無效的 voice_id")
        return v

class GenerateImageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=1000)

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

# ── 端點：取得聲音清單 ────────────────────────────────────────
@app.get("/api/voices")
def get_voices():
    return VOICES

# ── 語音生成 LRU 快取（記憶體，最多 200 筆，避免重複合成相同台詞）──────
_TTS_CACHE_MAX = 200
_tts_cache: "OrderedDict[str, tuple[bytes, str]]" = OrderedDict()  # key → (audio_bytes, fmt)

def _tts_cache_get(key: str) -> "tuple[bytes, str] | None":
    if key not in _tts_cache:
        return None
    _tts_cache.move_to_end(key)          # LRU: refresh access order
    return _tts_cache[key]

def _tts_cache_put(key: str, audio_bytes: bytes, fmt: str) -> None:
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
async def voice_preview(voice_id: str):
    if voice_id not in VALID_VOICE_IDS:
        raise HTTPException(status_code=404, detail="找不到此聲音")
    if voice_id in _voice_preview_cache:
        cached = _voice_preview_cache[voice_id]
        return {"audio_base64": base64.b64encode(cached).decode(), "format": "mp3"}
    sample_text = _VOICE_SAMPLE.get(voice_id, "大家好！我是故事裡的角色，很高興認識你。")

    # ── 1. 科大訊飛（與主要 TTS 端點一致，若已設定優先使用）────────
    if XFYUN_APP_ID and XFYUN_API_KEY and XFYUN_API_SECRET:
        try:
            audio = await _generate_voice_xfyun(sample_text, voice_id, "happy")
            if audio:
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
    if not _rl_title.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
        return t.strip('「」『』""\'').strip()

    # Try Groq first (faster, no think-block issues, ample rate limits)
    if GROQ_API_KEY:
        try:
            resp = await _http_client.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": "llama-3.1-8b-instant",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.9,
                    "max_tokens": 30,
                },
                timeout=20,
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"].get("content", "").strip()
            title = _clean_title(raw)
            if title and len(title) <= 20:
                logger.info("generate-title via Groq: %s", title)
                return {"title": title}
        except Exception as e:
            logger.warning("generate-title Groq failed: %s", e)

    # Fall back to MiniMax
    if MINIMAX_API_KEY:
        try:
            resp = await _http_client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.9,
                    "max_tokens": 30,
                },
                timeout=30,
            )
            resp.raise_for_status()
            raw_content = resp.json()["choices"][0]["message"].get("content", "")
            if isinstance(raw_content, list):
                raw_content = " ".join(b.get("text", "") for b in raw_content if b.get("type") == "text")
            title = _clean_title(str(raw_content))
            if title and len(title) <= 20:
                logger.info("generate-title via MiniMax: %s", title)
                return {"title": title}
            raise ValueError(f"invalid title: {title!r}")
        except Exception as e:
            logger.warning("generate-title MiniMax failed: %s", e)

    raise HTTPException(status_code=502, detail="書名生成失敗")


# ── Shared LLM helper: single-prompt → single-string (Groq → MiniMax) ────
async def _llm_single_string(
    prompt: str,
    clean_fn,
    *,
    temperature: float = 0.7,
    max_tokens: int = 100,
    log_tag: str = "llm",
    error_detail: str = "生成失敗",
) -> str:
    """Call Groq first, fall back to MiniMax; return the cleaned result or raise HTTP 502."""
    if GROQ_API_KEY:
        try:
            resp = await _http_client.post(
                GROQ_CHAT_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": "llama-3.1-8b-instant",
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
                    "model": "llama-3.1-8b-instant",
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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


# ── 端點：AI 書名建議 ─────────────────────────────────────────
class SuggestTitleRequest(BaseModel):
    story_context: Annotated[str, Field(max_length=5000)]
    style: Annotated[str, Field(max_length=20)] = "溫馨童趣"


@app.post("/api/suggest-title")
async def suggest_title(req: SuggestTitleRequest, request: Request):
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_script.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    if not MINIMAX_API_KEY and not GROQ_API_KEY:
        raise HTTPException(status_code=503, detail="服務未正確設定，請聯絡管理員")

    character_desc = "\n".join([
        f"- {c.name}（ID: {c.id}，個性：{c.personality}"
        + (f"，外形：{c.visual_description}" if c.visual_description else "")
        + f"，聲音類型：{c.voice_id}）"
        for c in req.characters
    ])

    line_length_rule = _LINE_LENGTH_RULES.get(req.line_length or "standard", _LINE_LENGTH_RULES["standard"])

    _raw_style = (req.image_style or "").strip()
    _img_style = _IMAGE_STYLE_EN.get(_raw_style, _raw_style) or "watercolor children's book illustration"

    prompt = f"""你是一位台灣繪本故事作家。請根據以下場景和角色，生成一段繪本對話劇本。

場景描述：{req.scene_description}
風格：{req.style}
角色列表：
{character_desc}

請回傳 JSON 格式，結構如下：
{{
  "lines": [
    {{
      "character_name": "角色名稱",
      "character_id": "角色ID（原封不動複製）",
      "voice_id": "聲音ID（原封不動複製）",
      "text": "這個角色說的話（自然口語，適合大聲朗讀）",
      "emotion": "happy|sad|surprised|angry|neutral 其中一個"
    }}
  ],
  "scene_prompt": "用英文描述這個場景的畫面（含角色外形描述），適合用來生成繪本插圖，風格為{_img_style}",
  "sfx_description": "建議的背景音效描述（例如：森林鳥鳴聲、輕柔鋼琴音樂）"
}}

注意：
- 請使用台灣繁體中文，符合台灣的語言習慣與用語，避免使用中國大陸用語
- 對話要自然有趣，適合兒童
- 每個角色至少說一句話
{line_length_rule}
- 角色在台詞中稱呼其他角色時，只能使用角色列表中的名字，不得自行發明暱稱或別名
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
                "model": "llama-3.3-70b-versatile",
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
    # On any failure, fall back to Groq llama-3.3-70b-versatile.
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
    code_block = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", content, re.DOTALL)
    if code_block:
        content = code_block.group(1)
    else:
        # 方式2：直接找第一個 { ... } 大括號區塊
        brace_match = re.search(r"\{.*\}", content, re.DOTALL)
        if brace_match:
            content = brace_match.group(0)

    try:
        data = json.loads(content)
    except Exception as e:
        logger.error("JSON parse failed: %s\nContent: %s", e, content[:800])
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
    if not _rl_voice.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")

    # ── 0. LRU 快取命中（相同 voice_id + emotion + text → 直接返回）──────
    _cache_key = f"{req.voice_id}:{req.emotion or ''}:{req.text}"
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
    rng = random.Random(hash(prompt) & 0xFFFFFF)

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
    if not _rl_image.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    full_prompt = f"{req.prompt}, soft colors, child-friendly, high quality"

    # ── 優先：HuggingFace Inference API（HUGGINGFACE_API_KEY）────
    if HUGGINGFACE_API_KEY:
        try:
            resp = await _http_client.post(
                HF_INFERENCE_URL,
                headers={"Authorization": f"Bearer {HUGGINGFACE_API_KEY}", "Content-Type": "application/json"},
                json={"inputs": full_prompt},
                timeout=60,
            )
            if resp.status_code == 200 and resp.content:
                b64 = base64.b64encode(resp.content).decode("utf-8")
                mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("HF image error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("HF image exception: %s", e)

    # ── 備用：Pollinations.ai → fetch 回來轉成 base64 ─────────────
    # gen.pollinations.ai/image/{prompt} 需要 API key（免費方案可申請）
    # 設定 POLLINATIONS_API_KEY 環境變數即可啟用；未設定則跳過（避免 401 延遲）
    if POLLINATIONS_API_KEY:
        encoded   = urllib.parse.quote(full_prompt)
        seed      = random.randint(1, 99999)
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

# ── 端點：圖片辨識（Groq Vision → 繁體中文場景描述）────────────
IMAGE_MAX_BYTES = 4 * 1024 * 1024  # 4 MB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

IMAGE_DESCRIBE_PROMPT = (
    "請用台灣繁體中文描述這張圖片的場景內容，100字以內，符合台灣語言習慣，適合作為兒童繪本的場景描述。"
)

@app.post("/api/recognize-image")
async def recognize_image(request: Request, file: UploadFile = File(...)):
    if not _rl_upload.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_upload.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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

    # Determine a safe filename extension for the multipart upload
    filename = file.filename or "audio.webm"

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
    character_id: str = Field("", max_length=64)
    character_name: str = Field("", max_length=30)
    voice_id: str = Field("", max_length=64)
    text: str = Field("", max_length=200)
    emotion: Optional[str] = Field("neutral", max_length=20)
    # audio_base64 may be a large data URI; cap at ~6 MB encoded (≈ 4.5 MB raw)
    audio_base64: Optional[str] = Field(None, max_length=6_000_000)
    audio_format: Optional[str] = Field(None, max_length=10)

class CharacterIn(BaseModel):
    """Character definition stored alongside a project."""
    id: str = Field("", max_length=64)
    name: str = Field("", max_length=30)
    personality: str = Field("", max_length=100)
    visual_description: str = Field("", max_length=200)
    voice_id: str = Field("", max_length=64)
    color: str = Field("", max_length=20)
    emoji: str = Field("", max_length=10)

class SceneIn(BaseModel):
    idx: int = Field(..., ge=0, le=999)
    description: str = Field("", max_length=500)
    style: str = Field("溫馨童趣", max_length=20)
    line_length: str = Field("standard", max_length=20)  # 'short' | 'standard' | 'long'
    script: Dict[str, Any] = {}
    lines: List[SceneLineIn] = Field(default_factory=list, max_length=50)
    # base64-encoded image: cap at ~6 MB of encoded data (≈ 4.5 MB raw)
    image: str = Field("", max_length=6_000_000)

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
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    _db_required()
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.id, p.name, p.created_at, p.updated_at,
                   p.cover_image,
                   COUNT(s.id)::int AS scene_count,
                   COALESCE(SUM(jsonb_array_length(s.lines)), 0)::int AS line_count
            FROM projects p
            LEFT JOIN scenes s ON s.project_id = p.id
            GROUP BY p.id
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
            "cover_image": r["cover_image"],
        }
        for r in rows
    ]


# ── POST /api/projects ────────────────────────────────────────
@app.post("/api/projects", status_code=201)
async def create_project(req: CreateProjectRequest, request: Request):
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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


# ── POST /api/projects/{project_id}/duplicate ─────────────────
@app.post("/api/projects/{project_id}/duplicate", status_code=201)
async def duplicate_project(project_id: str, request: Request):
    """Deep-copy a project: all scenes, characters, images, and cover thumbnail."""
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
            "SELECT idx, description, style, line_length, script, lines, image "
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
                      (project_id, idx, description, style, line_length, script, lines, image)
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
                    """,
                    [
                        (
                            new_id,
                            row["idx"],
                            row["description"],
                            row["style"],
                            row["line_length"] or "standard",
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
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id, name, characters, created_at, updated_at FROM projects WHERE id = $1",
            project_id,
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")
        scenes = await conn.fetch(
            "SELECT id, idx, description, style, line_length, script, lines, image FROM scenes WHERE project_id = $1 ORDER BY idx",
            project_id,
        )
    raw_chars = proj["characters"]
    characters = json.loads(raw_chars) if isinstance(raw_chars, str) else (raw_chars or [])
    return {
        "id": str(proj["id"]),
        "name": proj["name"],
        "characters": characters,
        "created_at": proj["created_at"].isoformat(),
        "updated_at": proj["updated_at"].isoformat(),
        "scenes": [
            {
                "id": str(s["id"]),
                "idx": s["idx"],
                "description": s["description"],
                "style": s["style"],
                "line_length": s["line_length"] or "standard",
                "script": json.loads(s["script"]) if isinstance(s["script"], str) else s["script"],
                "lines": json.loads(s["lines"]) if isinstance(s["lines"], str) else s["lines"],
                "image": s["image"],
            }
            for s in scenes
        ],
    }


# ── PUT /api/projects/{project_id}/characters ────────────────
class SaveCharactersRequest(BaseModel):
    characters: List[CharacterIn] = Field(default_factory=list, max_length=20)

@app.put("/api/projects/{project_id}/characters")
async def save_project_characters(project_id: str, req: SaveCharactersRequest, request: Request):
    """Persist just the characters list for a project (lightweight, no scene touch)."""
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT id FROM projects WHERE id = $1", project_id)
        if row is None:
            raise HTTPException(status_code=404, detail="專案不存在")
        await conn.execute(
            "UPDATE projects SET characters = $1::jsonb, updated_at = NOW() WHERE id = $2",
            json.dumps([c.model_dump() for c in req.characters], ensure_ascii=False),
            project_id,
        )
    return {"ok": True}


# ── PATCH /api/projects/{project_id} ─────────────────────────
@app.patch("/api/projects/{project_id}")
async def rename_project(project_id: str, req: RenameProjectRequest, request: Request):
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
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
    if not _rl_project.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    _db_required()
    _validate_uuid(project_id)

    # Compute the cover thumbnail BEFORE entering the transaction.
    # _make_cover_thumbnail is CPU-bound (Pillow); running it inside the
    # transaction keeps the DB connection acquired for the full thumbnail
    # generation time, blocking pool slots for other requests.  Computing
    # it up-front from the immutable request data lets us keep the
    # transaction as short as possible.
    cover_thumb: str | None = None
    first_image = next(
        (s.image for s in req.scenes if s.image and s.image != "error"), None
    )
    if first_image:
        cover_thumb = await asyncio.get_running_loop().run_in_executor(
            None, _make_cover_thumbnail, first_image
        )

    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow("SELECT id FROM projects WHERE id = $1", project_id)
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")

        async with conn.transaction():
            await conn.execute("DELETE FROM scenes WHERE project_id = $1", project_id)
            if req.scenes:
                await conn.executemany(
                    """
                    INSERT INTO scenes (project_id, idx, description, style, line_length, script, lines, image)
                    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)
                    """,
                    [
                        (
                            project_id,
                            scene.idx,
                            scene.description,
                            scene.style,
                            scene.line_length or "standard",
                            json.dumps(scene.script, ensure_ascii=False),
                            json.dumps([ln.model_dump() for ln in scene.lines], ensure_ascii=False),
                            scene.image,
                        )
                        for scene in req.scenes
                    ],
                )
            await conn.execute(
                """
                UPDATE projects
                SET updated_at = NOW(),
                    characters = $1::jsonb,
                    cover_image = $3
                WHERE id = $2
                """,
                json.dumps([c.model_dump() for c in req.characters], ensure_ascii=False),
                project_id,
                cover_thumb,
            )
    return {"ok": True}


# ── Export helpers ────────────────────────────────────────────

def _find_cjk_font() -> str | None:
    """Return path to a NotoSansCJK TTF/TTC font, or None if not found."""
    candidates = [
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    ]
    for c in candidates:
        if os.path.exists(c):
            return c
    hits = _glob.glob("/usr/share/fonts/**/*CJK*", recursive=True)
    if hits:
        return hits[0]
    return None


def _export_pdf(project_name: str, scenes: list, char_color_map: dict | None = None) -> bytes:
    try:
        from fpdf import FPDF
    except ImportError:
        raise HTTPException(status_code=501, detail="fpdf2 未安裝，PDF 匯出不可用")

    if char_color_map is None:
        char_color_map = {}

    font_path = _find_cjk_font()
    _use_cjk = font_path is not None

    class _PicturebookPDF(FPDF):
        """FPDF subclass that adds centered page numbers in the footer.

        Page 1 is the cover — we skip its footer so it stays clean.
        Scene pages are numbered starting from 1.
        """
        def footer(self) -> None:
            if self.page <= 1:   # cover page — no footer
                return
            self.set_y(-10)
            # Footer always uses regular weight to keep it subtle.
            if _use_cjk:
                self.set_font("NotoSansCJK", style="", size=8)
            else:
                self.set_font("Helvetica", style="", size=8)
            self.set_text_color(160, 160, 160)
            # page_no() counts from 1; subtract 1 so scene pages start at "第 1 頁".
            self.cell(0, 5, f"— 第 {self.page_no() - 1} 頁 —", align="C")
            self.set_text_color(0, 0, 0)

    pdf = _PicturebookPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)

    # Register CJK regular + bold fonts.
    # fpdf2 raises "Undefined font: notosanscjkB" if bold is requested but not
    # registered, which crashes the entire export.  Load the bold variant too
    # (NotoSansCJK-Bold.ttc ships alongside Regular in the Docker image).
    use_cjk = _use_cjk
    has_cjk_bold = False
    if use_cjk:
        pdf.add_font("NotoSansCJK", "", font_path)
        bold_path = font_path.replace("Regular", "Bold").replace("regular", "bold")
        if os.path.exists(bold_path):
            pdf.add_font("NotoSansCJK", "B", bold_path)
            has_cjk_bold = True

    def set_font_safe(size: int, style: str = ""):
        if use_cjk:
            # Fall back to regular when bold isn't registered to avoid crash
            effective_style = style if (style != "B" or has_cjk_bold) else ""
            pdf.set_font("NotoSansCJK", style=effective_style, size=size)
        else:
            pdf.set_font("Helvetica", style=style, size=size)

    # ── Cover page ───────────────────────────────────────────────────────
    pdf.add_page()

    # Title — centred vertically in the top half of the page
    set_font_safe(28, "B")
    pdf.set_y(90)
    pdf.cell(0, 14, project_name, align="C", new_x="LMARGIN", new_y="NEXT")

    set_font_safe(12)
    pdf.cell(0, 10, "繪本有聲書", align="C", new_x="LMARGIN", new_y="NEXT")

    # ── Story metadata ──────────────────────────────────────────────────
    total_lines = sum(len(s.get("lines", [])) for s in scenes)
    set_font_safe(10)
    pdf.set_text_color(120, 120, 120)
    pdf.ln(6)
    pdf.cell(0, 7, f"共 {len(scenes)} 幕  ·  {total_lines} 句台詞", align="C",
             new_x="LMARGIN", new_y="NEXT")
    pdf.set_text_color(0, 0, 0)

    # ── Character list ──────────────────────────────────────────────────
    # Build name list from char_color_map keys; fallback to scanning scenes.
    char_names: list[str] = list(char_color_map.keys()) if char_color_map else []
    if not char_names:
        seen: set[str] = set()
        for s in scenes:
            for ln in s.get("lines", []):
                n = ln.get("character_name", "")
                if n and n not in seen:
                    seen.add(n)
                    char_names.append(n)
    if char_names:
        pdf.ln(4)
        set_font_safe(9)
        pdf.set_text_color(100, 100, 100)
        char_line = "角色：" + "、".join(char_names[:8])
        if len(char_names) > 8:
            char_line += f" 等 {len(char_names)} 位"
        pdf.cell(0, 7, char_line, align="C", new_x="LMARGIN", new_y="NEXT")
        pdf.set_text_color(0, 0, 0)

    # ── Footer note ─────────────────────────────────────────────────────
    set_font_safe(8)
    pdf.set_text_color(180, 180, 180)
    pdf.set_y(-20)
    pdf.cell(0, 5, "由「繪本有聲書創作工坊」匯出", align="C")
    pdf.set_text_color(0, 0, 0)

    # Scene pages
    for i, scene in enumerate(scenes):
        pdf.add_page()
        current_y = 15

        # Title
        set_font_safe(16, "B")
        pdf.set_xy(10, current_y)
        pdf.cell(0, 10, f"第{i + 1}幕", align="L", new_x="LMARGIN", new_y="NEXT")
        current_y += 12

        # Description
        desc = scene.get("description", "")
        if desc:
            set_font_safe(10)
            pdf.set_xy(10, current_y)
            pdf.multi_cell(190, 6, desc)
            current_y = pdf.get_y() + 4

        # Image
        image_data = scene.get("image", "")
        if image_data and image_data.startswith("data:"):
            try:
                header, b64data = image_data.split(",", 1)
                img_ext = header.split("/")[1].split(";")[0]
                if img_ext == "jpeg":
                    img_ext = "jpg"
                img_bytes = base64.b64decode(b64data)
                with tempfile.NamedTemporaryFile(suffix=f".{img_ext}", delete=False) as tmp:
                    tmp.write(img_bytes)
                    tmp_path = tmp.name
                try:
                    # If less than 40 mm remain on the page, overflow to a new page
                    # so the image is never silently dropped.
                    available = 297 - current_y - 15  # 15 mm bottom margin
                    if available < 40:
                        pdf.add_page()
                        current_y = 15
                        available = 297 - current_y - 15
                    img_h = min(80, available)
                    pdf.image(tmp_path, x=10, y=current_y, w=190, h=img_h)
                    current_y += img_h + 4
                finally:
                    os.unlink(tmp_path)
            except Exception as e:
                logger.warning("PDF image embed failed: %s", e)
                set_font_safe(9)
                pdf.set_xy(10, current_y)
                pdf.cell(0, 6, "【插圖】", align="C")
                current_y += 8
        elif image_data:
            set_font_safe(9)
            pdf.set_xy(10, current_y)
            pdf.cell(0, 6, "【插圖】", align="C")
            current_y += 8

        # Dialogue lines
        lines = scene.get("lines", [])
        if lines:
            set_font_safe(11, "B")
            pdf.set_xy(10, current_y)
            pdf.cell(0, 8, "對白", new_x="LMARGIN", new_y="NEXT")
            current_y = pdf.get_y()

        for line in lines:
            raw_char_name = line.get("character_name", "")
            text = line.get("text", "")
            # Resolve per-character colour (empty string → no colour override)
            color_hex = _safe_css_color(char_color_map.get(raw_char_name, ""), fallback="")
            char_rgb = _hex_to_rgb(color_hex) if color_hex else None

            pdf.set_xy(10, current_y)
            # Render char name in bold + character colour, then text in regular black
            set_font_safe(10, "B")
            if char_rgb:
                pdf.set_text_color(*char_rgb)
            pdf.write(7, f"{raw_char_name}：")
            pdf.set_text_color(0, 0, 0)
            set_font_safe(10)
            pdf.write(7, text)
            pdf.ln(9)
            current_y = pdf.get_y() + 2

    return pdf.output()


def _export_epub(project_name: str, scenes: list, char_color_map: dict | None = None) -> bytes:
    try:
        from ebooklib import epub
    except ImportError:
        raise HTTPException(status_code=501, detail="ebooklib 未安裝，EPUB 匯出不可用")

    if char_color_map is None:
        char_color_map = {}

    book = epub.EpubBook()
    book.set_title(project_name)
    book.set_language("zh-TW")
    book.set_identifier(f"picturebook-{hash(project_name)}")

    css_content = """
body { font-family: 'Noto Sans CJK TC', 'Microsoft JhengHei', sans-serif; margin: 2em; line-height: 1.8; color: #333; }
h1 { color: #667eea; font-size: 1.4em; border-bottom: 2px solid #667eea; padding-bottom: 0.3em; }
.scene-desc { font-style: italic; color: #666; margin: 0.8em 0; font-size: 0.95em; }
.dialogue-table { width: 100%; border-collapse: collapse; margin: 1em 0; }
.dialogue-table td { padding: 8px 12px; vertical-align: top; }
.char-name { font-weight: bold; white-space: nowrap; width: 6em; }
.dialogue-text { color: #333; }
.scene-image { max-width: 100%; border-radius: 8px; margin: 1em auto; display: block; }
"""
    nav_css = epub.EpubItem(uid="style_nav", file_name="style/nav.css", media_type="text/css", content=css_content)
    book.add_item(nav_css)

    chapters = []

    for i, scene in enumerate(scenes):
        desc = html.escape(scene.get("description", ""))
        lines = scene.get("lines", [])
        image_data = scene.get("image", "")

        # Build image HTML
        img_html = ""
        if image_data and image_data.startswith("data:"):
            try:
                header, b64data = image_data.split(",", 1)
                mime = header.split(";")[0].replace("data:", "")
                ext = mime.split("/")[1]
                if ext == "jpeg":
                    ext = "jpg"
                img_bytes = base64.b64decode(b64data)
                img_item = epub.EpubItem(
                    uid=f"img_{i}",
                    file_name=f"images/scene{i}.{ext}",
                    media_type=mime,
                    content=img_bytes,
                )
                book.add_item(img_item)
                img_html = f'<img src="../images/scene{i}.{ext}" class="scene-image" alt="第{i+1}幕插圖"/>'
            except Exception as e:
                logger.warning("EPUB image embed failed: %s", e)
        elif image_data:
            safe_src = html.escape(image_data, quote=True)
            img_html = f'<img src="{safe_src}" class="scene-image" alt="第{i+1}幕插圖"/>'

        # Build dialogue HTML — escape user-supplied text to prevent XSS in XHTML.
        # Apply per-character accent colour via inline style (CSS custom properties
        # are not reliable across all EPUB readers, so we use direct color values).
        dialogue_rows = ""
        for line in lines:
            raw_char_name = line.get("character_name", "")
            char_name = html.escape(raw_char_name)
            text = html.escape(line.get("text", ""))
            char_color = _safe_css_color(char_color_map.get(raw_char_name, ""))
            dialogue_rows += (
                f'<tr>'
                f'<td class="char-name" style="color:{char_color}">{char_name}</td>'
                f'<td class="dialogue-text">{text}</td>'
                f'</tr>'
            )

        dialogue_html = ""
        if dialogue_rows:
            dialogue_html = f'<table class="dialogue-table"><tbody>{dialogue_rows}</tbody></table>'

        # Add audio items
        audio_items_html = ""
        for j, line in enumerate(lines):
            audio_b64 = line.get("audio_base64")
            if audio_b64:
                try:
                    audio_bytes = base64.b64decode(audio_b64)
                    audio_item = epub.EpubItem(
                        uid=f"audio_{i}_{j}",
                        file_name=f"audio/scene{i}_line{j}.mp3",
                        media_type="audio/mpeg",
                        content=audio_bytes,
                    )
                    book.add_item(audio_item)
                    safe_char = html.escape(line.get("character_name", ""))
                    audio_items_html += (
                        f'<audio controls src="../audio/scene{i}_line{j}.mp3">'
                        f'<p>{safe_char}</p></audio>'
                    )
                except Exception as e:
                    logger.warning("EPUB audio embed failed: %s", e)

        chapter_content = f"""<?xml version='1.0' encoding='utf-8'?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
<head>
  <title>第{i+1}幕</title>
  <link rel="stylesheet" type="text/css" href="../style/nav.css"/>
</head>
<body>
  <h1>第{i+1}幕</h1>
  <p class="scene-desc">{desc}</p>
  {img_html}
  {dialogue_html}
  {audio_items_html}
</body>
</html>"""

        chapter = epub.EpubHtml(title=f"第{i+1}幕", file_name=f"scenes/scene_{i}.xhtml", lang="zh-TW")
        chapter.content = chapter_content
        chapter.add_item(nav_css)
        book.add_item(chapter)
        chapters.append(chapter)

    book.toc = tuple(chapters)
    book.add_item(epub.EpubNcx())
    book.add_item(epub.EpubNav())
    book.spine = ["nav"] + chapters

    buf = io.BytesIO()
    epub.write_epub(buf, book)
    return buf.getvalue()


_SAFE_CSS_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{3,8}$')


def _safe_css_color(color: str, fallback: str = "#667eea") -> str:
    """Validate a CSS hex color; return fallback if it doesn't look safe."""
    return color if _SAFE_CSS_COLOR_RE.match(color or "") else fallback


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


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int] | None:
    """Convert a #RRGGBB or #RGB hex string to an (r, g, b) int tuple.

    Returns None for any malformed input so callers can gracefully skip
    colour application rather than crashing the export.
    """
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = h[0] * 2 + h[1] * 2 + h[2] * 2
    if len(h) != 6:
        return None
    try:
        return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    except ValueError:
        return None


def _export_html_zip(
    project_name: str,
    scenes: list,
    char_color_map: dict | None = None,
    characters: list | None = None,
) -> bytes:
    # Build a self-contained index.html with all scenes.
    # char_color_map: {character_name: hex_color} — used for per-character
    # dialogue border colours.  Falls back to the brand purple when absent.
    if char_color_map is None:
        char_color_map = {}
    if characters is None:
        characters = []

    # Build name→emoji lookup so dialogue lines can show the character's emoji.
    char_emoji_map: dict[str, str] = {
        c.get("name", ""): c.get("emoji", "")
        for c in characters
        if c.get("name")
    }

    scene_htmls = []
    for i, scene in enumerate(scenes):
        desc = html.escape(scene.get("description", ""))
        lines = scene.get("lines", [])
        image_data = scene.get("image", "")

        # image_data is either a data: URI (safe, produced by the server) or an
        # external URL stored in the DB.  Escape it for the HTML attribute context
        # to prevent attribute-breakout injection.
        if image_data:
            safe_src = html.escape(image_data, quote=True)
            img_tag = f'<img class="scene-img" src="{safe_src}" alt="第{i+1}幕插圖"/>'
        else:
            img_tag = '<div class="scene-img-placeholder">【插圖待生成】</div>'

        line_divs = ""
        for j, line in enumerate(lines):
            raw_char_name = line.get("character_name", "")
            char_name = html.escape(raw_char_name)
            char_emoji = html.escape(char_emoji_map.get(raw_char_name, ""))
            text = html.escape(line.get("text", ""))
            audio_b64 = line.get("audio_base64")
            audio_fmt = line.get("audio_format", "mp3")
            if audio_b64:
                mime = "audio/mpeg" if audio_fmt in ("mp3",) else f"audio/{audio_fmt}"
                audio_tag = (
                    f'<audio id="audio-{i}-{j}" src="data:{mime};base64,{audio_b64}" preload="auto"></audio>'
                    f'<button class="btn-play" onclick="playLine({i},{j})">▶ 播放</button>'
                )
            else:
                audio_tag = '<span class="no-audio">（無音檔）</span>'

            # Per-character accent colour via CSS custom property so the
            # `.playing` class can still override `border-left-color`.
            char_color = _safe_css_color(char_color_map.get(raw_char_name, ""))
            emoji_span = f'<span class="char-emoji">{char_emoji}</span>' if char_emoji else ""
            line_divs += f"""
        <div class="dialogue-line" id="line-{i}-{j}" style="--char-color:{char_color}">
          <span class="char-label" style="color:{char_color}">{emoji_span}<span class="char-name">{char_name}</span></span>
          <span class="dialogue-text">{text}</span>
          {audio_tag}
        </div>"""

        back_link = (
            '<a href="#toc" class="scene-back-link">↑ 回目次</a>'
            if len(scenes) >= 2 else ""
        )
        scene_htmls.append(f"""
  <section class="scene-card" id="scene-{i}">
    <h2 class="scene-title">第{i+1}幕</h2>
    <p class="scene-desc">{desc}</p>
    {img_tag}
    <div class="dialogue-block">{line_divs}
    </div>
    {back_link}
  </section>""")

    scenes_joined = "\n".join(scene_htmls)

    # ── Character introduction section ──────────────────────────────────────
    # Count dialogue lines per character name across all scenes.
    char_line_counts: dict[str, int] = {}
    for scene in scenes:
        for line in scene.get("lines", []):
            cname = line.get("character_name", "")
            if cname:
                char_line_counts[cname] = char_line_counts.get(cname, 0) + 1

    char_intro_html = ""
    if characters:
        char_cards = ""
        for c in characters:
            name       = html.escape(str(c.get("name", "")))
            emoji      = html.escape(str(c.get("emoji", "🎭")))
            personality = html.escape(str(c.get("personality", "")))
            color      = _safe_css_color(c.get("color", ""), fallback="#667eea")
            line_count = char_line_counts.get(c.get("name", ""), 0)
            line_badge = (
                f'<div class="char-intro-lines" style="color:{color}">{line_count} 句</div>'
                if line_count > 0 else ""
            )
            char_cards += f"""
      <div class="char-intro-card" style="border-top-color:{color}">
        <div class="char-intro-emoji">{emoji}</div>
        <div class="char-intro-name" style="color:{color}">{name}</div>
        {f'<div class="char-intro-personality">{personality}</div>' if personality else ''}
        {line_badge}
      </div>"""
        char_intro_html = f"""
  <section class="char-intro-section">
    <h2 class="char-intro-title">✨ 認識角色</h2>
    <div class="char-intro-grid">{char_cards}
    </div>
  </section>"""

    # ── Table of contents (only when there are 2+ scenes) ───────────────────
    toc_html = ""
    if len(scenes) >= 2:
        toc_items = ""
        for i, scene in enumerate(scenes):
            desc = html.escape(scene.get("description", f"第{i+1}幕") or f"第{i+1}幕")
            has_audio = any(line.get("audio_base64") for line in scene.get("lines", []))
            audio_badge = ' <span class="toc-audio-badge">🔊</span>' if has_audio else ""
            toc_items += f"""
      <li class="toc-item">
        <a href="#scene-{i}" class="toc-link">
          <span class="toc-num">第 {i+1} 幕</span>
          <span class="toc-desc">{desc}</span>
          {audio_badge}
        </a>
      </li>"""
        toc_html = f"""
  <section class="toc-section" id="toc">
    <h2 class="toc-title">📖 目次</h2>
    <ol class="toc-list">{toc_items}
    </ol>
  </section>"""

    escaped_project_name = html.escape(project_name)
    html_doc = f"""<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>{escaped_project_name}</title>
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif; background: #f0f4ff; color: #333; }}
    header {{ background: linear-gradient(135deg,#667eea,#764ba2); color: white; text-align: center; padding: 32px 16px; }}
    header h1 {{ font-size: 2rem; margin-bottom: 8px; }}
    main {{ max-width: 860px; margin: 0 auto; padding: 32px 16px; display: flex; flex-direction: column; gap: 32px; }}
    .scene-card {{ background: white; border-radius: 16px; padding: 28px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }}
    .scene-title {{ font-size: 1.3rem; font-weight: 800; color: #667eea; margin-bottom: 8px; }}
    .scene-desc {{ color: #888; font-style: italic; margin-bottom: 16px; }}
    .scene-img {{ width: 100%; border-radius: 12px; margin-bottom: 20px; }}
    .scene-img-placeholder {{ background: #f0f0f0; border-radius: 12px; height: 200px; display: flex; align-items: center; justify-content: center; color: #bbb; margin-bottom: 20px; }}
    .dialogue-block {{ display: flex; flex-direction: column; gap: 12px; }}
    .dialogue-line {{ display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: #fafbff; border-radius: 10px; padding: 10px 14px; border-left: 4px solid var(--char-color, #667eea); }}
    .char-label {{ display: flex; align-items: center; gap: 4px; font-weight: 700; white-space: nowrap; min-width: 4em; }}
    .char-emoji {{ font-size: 1.1em; line-height: 1; }}
    .char-name {{ font-weight: 700; }}
    .dialogue-text {{ flex: 1; font-size: 1rem; line-height: 1.6; }}
    .btn-play {{ background: linear-gradient(135deg,#43e97b,#38f9d7); border: none; border-radius: 20px; padding: 5px 14px; cursor: pointer; font-weight: 700; font-size: 0.85rem; color: white; transition: opacity 0.15s; }}
    .btn-play:hover {{ opacity: 0.85; }}
    .no-audio {{ font-size: 0.78rem; color: #bbb; font-style: italic; }}
    footer {{ text-align: center; padding: 24px; color: #aaa; font-size: 0.8rem; padding-bottom: 100px; }}
    .dialogue-line.playing {{ background: #eef0ff; border-left-color: #43e97b; box-shadow: 0 0 0 2px #43e97b44; }}
    /* ── sticky player bar ── */
    #player-bar {{
      position: fixed; bottom: 0; left: 0; right: 0;
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: white; padding: 10px 16px; padding-top: 14px;
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.18);
      z-index: 999; font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
    }}
    #player-bar.hidden {{ display: none; }}
    /* ── playback progress track ── */
    #player-track {{
      position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: rgba(255,255,255,0.15); border-radius: 2px 2px 0 0;
    }}
    #player-fill {{
      height: 100%; width: 0%; border-radius: 2px 2px 0 0;
      background: linear-gradient(90deg,#43e97b,#38f9d7);
      transition: width 0.4s ease;
    }}
    #btn-play-all {{
      background: linear-gradient(135deg,#43e97b,#38f9d7);
      border: none; border-radius: 24px; padding: 7px 18px;
      font-weight: 800; font-size: 0.95rem; color: white;
      cursor: pointer; white-space: nowrap; transition: opacity .15s;
    }}
    #btn-play-all:hover {{ opacity: .85; }}
    .btn-player-nav {{
      background: rgba(255,255,255,0.15); border: none; border-radius: 18px;
      padding: 6px 13px; color: white; cursor: pointer; font-size: 0.9rem;
      transition: opacity .15s; white-space: nowrap;
    }}
    .btn-player-nav:hover {{ opacity: .75; }}
    #player-now {{ flex: 1; font-size: 0.88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .92; min-width: 80px; }}
    #player-progress {{ font-size: 0.78rem; opacity: .65; white-space: nowrap; }}
    .speed-btns {{ display: flex; gap: 5px; }}
    .speed-btn {{
      background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
      border-radius: 14px; padding: 4px 10px; color: rgba(255,255,255,0.7);
      cursor: pointer; font-size: 0.75rem; font-weight: 700; transition: all .15s;
    }}
    .speed-btn.active {{ background: rgba(255,255,255,0.3); color: white; border-color: rgba(255,255,255,0.5); }}
    /* header launch button */
    .header-play-btn {{
      margin-top: 14px; background: white; color: #667eea;
      border: none; border-radius: 28px; padding: 10px 28px;
      font-weight: 800; font-size: 1rem; cursor: pointer;
      transition: box-shadow .15s;
    }}
    .header-play-btn:hover {{ box-shadow: 0 4px 16px rgba(0,0,0,.18); }}
    /* ── character intro ── */
    .char-intro-section {{
      background: white; border-radius: 16px; padding: 24px 28px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08); margin-bottom: 0;
    }}
    .char-intro-title {{
      font-size: 1.1rem; font-weight: 800; color: #667eea; margin-bottom: 16px;
    }}
    .char-intro-grid {{
      display: flex; flex-wrap: wrap; gap: 14px;
    }}
    .char-intro-card {{
      background: #fafbff; border-radius: 12px; padding: 14px 18px;
      border-top: 4px solid #667eea; text-align: center;
      min-width: 90px; flex: 0 0 auto;
      box-shadow: 0 1px 6px rgba(0,0,0,0.06);
    }}
    .char-intro-emoji {{ font-size: 2rem; line-height: 1.2; margin-bottom: 4px; }}
    .char-intro-name {{ font-weight: 800; font-size: 0.95rem; margin-bottom: 4px; }}
    .char-intro-personality {{ font-size: 0.75rem; color: #888; line-height: 1.4; max-width: 120px; }}
    .char-intro-lines {{ font-size: 0.72rem; font-weight: 700; margin-top: 5px; opacity: 0.85; }}
    /* ── table of contents ── */
    .toc-section {{
      background: white; border-radius: 16px; padding: 24px 28px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.08);
    }}
    .toc-title {{ font-size: 1.1rem; font-weight: 800; color: #667eea; margin-bottom: 14px; }}
    .toc-list {{ list-style: none; display: flex; flex-direction: column; gap: 6px; }}
    .toc-item {{ display: flex; }}
    .toc-link {{
      display: flex; align-items: baseline; gap: 10px; width: 100%;
      text-decoration: none; color: #444; padding: 8px 12px; border-radius: 10px;
      transition: background 0.15s;
    }}
    .toc-link:hover {{ background: #f0f4ff; color: #667eea; }}
    .toc-num {{ font-weight: 800; color: #667eea; white-space: nowrap; min-width: 4em; }}
    .toc-desc {{ flex: 1; font-size: 0.92rem; color: #666; }}
    .toc-link:hover .toc-desc {{ color: #667eea; }}
    .toc-audio-badge {{ font-size: 0.8rem; opacity: 0.6; }}
    .scene-back-link {{
      display: inline-block; margin-top: 16px; font-size: 0.8rem;
      color: #aaa; text-decoration: none; transition: color 0.15s;
    }}
    .scene-back-link:hover {{ color: #667eea; }}
    /* ── print / save-as-PDF ── */
    @media print {{
      body {{ background: white; color: #222; }}
      header {{ background: #667eea; -webkit-print-color-adjust: exact; print-color-adjust: exact; padding: 20px 16px; }}
      header h1 {{ font-size: 1.6rem; }}
      .header-play-btn {{ display: none; }}
      #player-bar {{ display: none !important; }}
      footer {{ padding-bottom: 16px; }}
      main {{ padding: 16px; gap: 20px; }}
      .scene-card {{ box-shadow: none; border: 1px solid #dde; page-break-inside: avoid; break-inside: avoid; }}
      .char-intro-section, .toc-section {{ box-shadow: none; border: 1px solid #dde; page-break-inside: avoid; break-inside: avoid; }}
      .toc-link {{ color: #333; }}
      .toc-link:hover {{ background: none; }}
      .scene-img {{ max-height: 320px; object-fit: contain; }}
      .dialogue-line {{ page-break-inside: avoid; break-inside: avoid; }}
      .btn-play {{ display: none; }}
      .no-audio {{ display: none; }}
      .scene-back-link {{ display: none; }}
      audio {{ display: none; }}
    }}
  </style>
</head>
<body>
  <header>
    <h1>{escaped_project_name}</h1>
    <p>繪本有聲書互動版</p>
    <button class="header-play-btn" onclick="startPlayAll()">▶ 播放全書</button>
  </header>
  <main>
{char_intro_html}
{toc_html}
{scenes_joined}
  </main>
  <footer>由「繪本有聲書創作工坊」匯出</footer>

  <!-- Sticky player bar (hidden until Play All starts) -->
  <div id="player-bar" class="hidden">
    <div id="player-track"><div id="player-fill"></div></div>
    <button id="btn-play-all" onclick="togglePlayAll()">⏸ 暫停</button>
    <button class="btn-player-nav" onclick="prevLine()" title="上一句 (←)">◀</button>
    <button class="btn-player-nav" onclick="nextLine()" title="下一句 (→)">▶</button>
    <span id="player-now">準備播放...</span>
    <span id="player-progress"></span>
    <div class="speed-btns">
      <button class="speed-btn" onclick="setSpeed(0.75)">0.75×</button>
      <button class="speed-btn active" onclick="setSpeed(1)">1×</button>
      <button class="speed-btn" onclick="setSpeed(1.5)">1.5×</button>
      <button class="speed-btn" onclick="setSpeed(2)">2×</button>
    </div>
  </div>

  <script>
    // ── per-line playback ──
    function playLine(sceneIdx, lineIdx) {{
      var audio = document.getElementById('audio-' + sceneIdx + '-' + lineIdx);
      if (audio) {{ audio.currentTime = 0; audio.play(); }}
    }}

    // ── Play-All logic ──
    var _playlist = [];   // {{id, charName, text}}
    var _cursor   = -1;
    var _paused   = false;
    var _speed    = 1.0;

    function _buildPlaylist() {{
      var items = [];
      document.querySelectorAll('.dialogue-line').forEach(function(el) {{
        var audio = el.querySelector('audio');
        if (!audio) return;
        items.push({{
          audioId: audio.id,
          lineId: el.id,
          charName: (el.querySelector('.char-label') || el.querySelector('.char-name') || {{}}).textContent || '',
          text: (el.querySelector('.dialogue-text') || {{}}).textContent || '',
        }});
      }});
      return items;
    }}

    function startPlayAll() {{
      _playlist = _buildPlaylist();
      if (_playlist.length === 0) {{ alert('此繪本尚無音檔，請先在「創作工坊」生成配音。'); return; }}
      _cursor = -1;
      _paused = false;
      document.getElementById('player-fill').style.width = '0%';
      document.getElementById('player-bar').classList.remove('hidden');
      _advance();
    }}

    function _advance() {{
      // clear previous highlight
      document.querySelectorAll('.dialogue-line.playing').forEach(function(el) {{
        el.classList.remove('playing');
      }});
      _cursor++;
      if (_cursor >= _playlist.length) {{
        // finished
        document.getElementById('player-now').textContent = '✓ 播放完畢';
        document.getElementById('player-progress').textContent = '';
        document.getElementById('btn-play-all').textContent = '▶ 重播全書';
        document.getElementById('player-fill').style.width = '100%';
        _cursor = -1;
        return;
      }}
      _playAt(_cursor);
    }}

    function _playAt(idx) {{
      var item = _playlist[idx];
      var lineEl = document.getElementById(item.lineId);
      if (lineEl) {{
        lineEl.classList.add('playing');
        lineEl.scrollIntoView({{ behavior: 'smooth', block: 'center' }});
      }}
      document.getElementById('player-now').textContent = item.charName + '：' + item.text;
      document.getElementById('player-progress').textContent = (idx + 1) + ' / ' + _playlist.length;
      var pct = _playlist.length > 0 ? ((idx + 1) / _playlist.length * 100) : 0;
      document.getElementById('player-fill').style.width = pct + '%';

      var audio = document.getElementById(item.audioId);
      if (!audio) {{ _advance(); return; }}
      audio.currentTime = 0;
      audio.playbackRate = _speed;
      audio.onended = function() {{
        if (!_paused) _advance();
      }};
      audio.play().catch(function() {{ _advance(); }});
    }}

    function togglePlayAll() {{
      if (_cursor === -1) {{ startPlayAll(); return; }}
      var btn = document.getElementById('btn-play-all');
      if (_paused) {{
        _paused = false;
        btn.textContent = '⏸ 暫停';
        if (_cursor >= 0 && _cursor < _playlist.length) {{
          var a = document.getElementById(_playlist[_cursor].audioId);
          if (a) a.play().catch(function(){{}});
        }}
      }} else {{
        _paused = true;
        btn.textContent = '▶ 繼續';
        document.querySelectorAll('audio').forEach(function(a) {{ a.pause(); }});
      }}
    }}

    function setSpeed(s) {{
      _speed = s;
      document.querySelectorAll('.speed-btn').forEach(function(btn) {{
        btn.classList.toggle('active', parseFloat(btn.textContent) === s);
      }});
      document.querySelectorAll('audio').forEach(function(a) {{ a.playbackRate = s; }});
    }}

    function prevLine() {{
      if (_cursor <= 0) return;
      document.querySelectorAll('audio').forEach(function(a) {{ a.pause(); }});
      _cursor -= 2;  // _advance() will increment by 1
      _advance();
    }}

    function nextLine() {{
      document.querySelectorAll('audio').forEach(function(a) {{ a.pause(); }});
      _advance();
    }}

    // keyboard shortcuts: Space = toggle, Esc = stop, ← prev, → next
    document.addEventListener('keydown', function(e) {{
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {{ e.preventDefault(); togglePlayAll(); }}
      if (e.code === 'ArrowRight') {{ e.preventDefault(); nextLine(); }}
      if (e.code === 'ArrowLeft') {{ e.preventDefault(); prevLine(); }}
      if (e.code === 'Escape') {{
        document.querySelectorAll('audio').forEach(function(a) {{ a.pause(); }});
        document.querySelectorAll('.dialogue-line.playing').forEach(function(el) {{ el.classList.remove('playing'); }});
        document.getElementById('player-bar').classList.add('hidden');
        _cursor = -1; _paused = false;
      }}
    }});
  </script>
</body>
</html>"""

    return html_doc.encode("utf-8")


def _export_mp3_zip(project_name: str, scenes: list) -> bytes:
    buf = io.BytesIO()
    readme_lines = [f"《{project_name}》有聲書音檔", "=" * 40, ""]
    has_any_audio = False

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, scene in enumerate(scenes):
            folder = f"幕{i+1:02d}"
            lines = scene.get("lines", [])
            desc = scene.get("description", "")
            readme_lines.append(f"【第{i+1}幕】{desc}")

            for j, line in enumerate(lines):
                char_name = line.get("character_name", "")
                text = line.get("text", "")
                audio_b64 = line.get("audio_base64")
                # audio_format is "mp3" for iFlytek/Edge TTS and "wav" for Groq Orpheus fallback.
                # Using the wrong extension (e.g. ".mp3" for a WAV file) causes playback failures
                # in media players that trust the file extension over the stream header.
                audio_fmt = (line.get("audio_format") or "mp3").lower()
                readme_lines.append(f"  行{j+1:02d} {char_name}：{text}")
                if audio_b64:
                    try:
                        audio_bytes = base64.b64decode(audio_b64)
                        # Sanitise char_name for filename
                        safe_name = re.sub(r'[\\/:*?"<>|]', "_", char_name)
                        filename = f"{folder}/{folder}_行{j+1:02d}_{safe_name}.{audio_fmt}"
                        zf.writestr(filename, audio_bytes)
                        has_any_audio = True
                    except Exception as e:
                        logger.warning("MP3 ZIP audio decode failed: %s", e)
                else:
                    readme_lines.append("    （此行無音檔）")

            readme_lines.append("")

        readme_lines.append("=" * 40)
        if not has_any_audio:
            readme_lines.append("注意：此作品尚未生成任何語音，請先在創作工坊中生成配音後再匯出。")
        zf.writestr("README.txt", "\n".join(readme_lines).encode("utf-8"))

    return buf.getvalue()


# ── GET /api/projects/{project_id}/export ────────────────────
_EXPORT_FORMAT = Literal["pdf", "epub", "html", "mp3"]

@app.get("/api/projects/{project_id}/export")
async def export_project(
    request: Request,
    project_id: str,
    format: _EXPORT_FORMAT = "pdf",
):
    if not _rl_export.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="匯出請求過於頻繁，請稍後再試")
    _db_required()
    _validate_uuid(project_id)

    # Load project from DB
    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id, name, characters FROM projects WHERE id = $1", project_id
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")
        scene_rows = await conn.fetch(
            "SELECT idx, description, style, lines, image FROM scenes "
            "WHERE project_id = $1 ORDER BY idx",
            project_id,
        )

    project_name = proj["name"]

    # Build name→color map for per-character accent colours in exports.
    raw_chars = proj["characters"] or []
    if isinstance(raw_chars, str):
        raw_chars = json.loads(raw_chars)
    char_color_map: dict[str, str] = {
        c.get("name", ""): c.get("color", "")
        for c in raw_chars
        if c.get("name")
    }

    scenes = []
    for row in scene_rows:
        raw_lines = row["lines"]
        if isinstance(raw_lines, str):
            raw_lines = json.loads(raw_lines)
        scenes.append({
            "idx": row["idx"],
            "description": row["description"],
            "style": row["style"],
            "lines": raw_lines,
            "image": row["image"],
        })

    # Run CPU-bound export functions in a thread pool to avoid blocking
    # the async event loop (PDF rendering / EPUB serialisation can take >1 s)
    loop = asyncio.get_running_loop()
    if format == "pdf":
        data = await loop.run_in_executor(None, _export_pdf, project_name, scenes, char_color_map)
        media_type = "application/pdf"
        filename = f"{project_name}.pdf"
    elif format == "epub":
        data = await loop.run_in_executor(None, _export_epub, project_name, scenes, char_color_map)
        media_type = "application/epub+zip"
        filename = f"{project_name}.epub"
    elif format == "html":
        data = await loop.run_in_executor(None, _export_html_zip, project_name, scenes, char_color_map, raw_chars)
        media_type = "text/html; charset=utf-8"
        filename = f"{project_name}.html"
    else:  # "mp3"
        data = await loop.run_in_executor(None, _export_mp3_zip, project_name, scenes)
        media_type = "application/zip"
        filename = f"{project_name}_audio.zip"

    # URL-encode filename for Content-Disposition
    encoded_filename = urllib.parse.quote(filename)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}",
        "Content-Length": str(len(data)),
    }
    return StreamingResponse(io.BytesIO(data), media_type=media_type, headers=headers)


# ── 健康檢查 ──────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok"}
