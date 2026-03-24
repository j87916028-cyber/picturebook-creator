import html
import io
import os
import re
import json
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
from collections import defaultdict, deque
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
        # Periodically evict empty buckets to prevent unbounded memory growth.
        # Without this, each unique client IP (including spoofed X-Forwarded-For
        # values) leaves a permanent entry in the dict.
        if now - self._last_prune > 300:  # every 5 minutes
            self._last_prune = now
            stale = [k for k, v in self._calls.items() if not v]
            for k in stale:
                del self._calls[k]
        return True


def _client_ip(request: Request) -> str:
    """Best-effort client IP: respects X-Forwarded-For from trusted proxies."""
    forwarded = request.headers.get("X-Forwarded-For")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# Per-endpoint limits (per IP, per minute)
_rl_script  = _RateLimiter(max_calls=10,  window_secs=60)   # LLM script gen
_rl_voice   = _RateLimiter(max_calls=60,  window_secs=60)   # TTS (many lines/scene)
_rl_image   = _RateLimiter(max_calls=10,  window_secs=60)   # Image gen
_rl_suggest = _RateLimiter(max_calls=15,  window_secs=60)   # Scene suggestions
_rl_title   = _RateLimiter(max_calls=15,  window_secs=60)   # Title gen
_rl_upload  = _RateLimiter(max_calls=20,  window_secs=60)   # Image/audio upload

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

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Initialise Gemini client once at startup (not per-request)
_gemini_client = None
_gemini_image_config = None
if GEMINI_API_KEY:
    try:
        from google import genai as _genai
        from google.genai import types as _gtypes
        _gemini_client = _genai.Client(api_key=GEMINI_API_KEY)
        _gemini_image_config = _gtypes.GenerateImagesConfig(
            number_of_images=1, aspect_ratio="4:3", language="zh"
        )
        logger.info("Gemini client initialised")
    except Exception as _e:
        logger.warning("Gemini init failed: %s", _e)

HUGGINGFACE_API_KEY = os.getenv("HUGGINGFACE_API_KEY", "")
HF_IMAGE_MODEL = "black-forest-labs/FLUX.1-schnell"
HF_INFERENCE_URL = f"https://api-inference.huggingface.co/models/{HF_IMAGE_MODEL}"

# ── 可用聲音清單 ─────────────────────────────────────────────
VOICES = [
    {"id": "female-tianmei-jingpin", "label": "甜美女聲",   "emoji": "👧"},
    {"id": "female-shaonv",          "label": "少女音",     "emoji": "🧒"},
    {"id": "female-yujie",           "label": "御姐音",     "emoji": "👩"},
    {"id": "female-chengshu",        "label": "成熟女聲",   "emoji": "👩‍💼"},
    {"id": "male-qn-qingse",         "label": "青澀男聲",   "emoji": "👦"},
    {"id": "male-qn-jingying",       "label": "精英男聲",   "emoji": "🧑‍💼"},
    {"id": "male-qn-badao",          "label": "霸道男聲",   "emoji": "👨"},
    {"id": "presenter_male",         "label": "播報男聲",   "emoji": "🎙️"},
    {"id": "audiobook_male_2",       "label": "說書男聲",   "emoji": "📖"},
    {"id": "audiobook_female_2",     "label": "說書女聲",   "emoji": "📚"},
    {"id": "cute_boy",               "label": "可愛男孩",   "emoji": "🐣"},
    {"id": "elderly_man",            "label": "老爺爺音",   "emoji": "👴"},
    {"id": "elderly_woman",          "label": "老奶奶音",   "emoji": "👵"},
]

VALID_VOICE_IDS = {v["id"] for v in VOICES}

# MiniMax voice ID → Groq Orpheus voice
VOICE_TO_GROQ = {
    "female-tianmei-jingpin": "diana",
    "female-shaonv":          "autumn",
    "female-yujie":           "diana",
    "female-chengshu":        "hannah",
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

# MiniMax voice ID → Microsoft Edge TTS voice（全部使用台灣腔 zh-TW）
VOICE_TO_EDGE = {
    "female-tianmei-jingpin": "zh-TW-HsiaoYuNeural",   # 甜美女聲
    "female-shaonv":          "zh-TW-HsiaoYuNeural",   # 少女音
    "female-yujie":           "zh-TW-HsiaoChenNeural", # 御姐音
    "female-chengshu":        "zh-TW-HsiaoChenNeural", # 成熟女聲
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

# ── Models ───────────────────────────────────────────────────
class Character(BaseModel):
    id: str = Field(..., max_length=64)
    name: str = Field(..., min_length=1, max_length=30)
    personality: str = Field(..., max_length=100)
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
    story_context: Optional[str] = Field(None, max_length=3000)

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
    style: Optional[str] = Field("繪本插畫", max_length=20)

class ScriptLine(BaseModel):
    character_name: str
    character_id: str
    voice_id: str
    text: str
    emotion: Optional[str] = "neutral"

class ScriptResponse(BaseModel):
    lines: List[ScriptLine]
    scene_prompt: str
    sfx_description: str

# ── 端點：取得聲音清單 ────────────────────────────────────────
@app.get("/api/voices")
def get_voices():
    return VOICES

# ── 聲音試聽快取（記憶體，每個 voice 只合成一次）──────────────
_voice_preview_cache: dict[str, bytes] = {}

# 每種聲音類型對應的試聽範例句
_VOICE_SAMPLE: dict[str, str] = {
    "female-tianmei-jingpin": "嗨！大家好，我是你的故事角色，很高興認識你喔！",
    "female-shaonv":          "嗨嗨！今天的冒險要開始囉，準備好了嗎？",
    "female-yujie":           "嗯，這個故事才剛開始，有趣的事還在後頭呢。",
    "female-chengshu":        "孩子們，今天的故事讓我們一起來聽聽看吧。",
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
    edge_voice = VOICE_TO_EDGE.get(voice_id, "zh-TW-HsiaoYuNeural")
    try:
        ssml = _build_ssml(sample_text, edge_voice, "happy", voice_id)
        communicate = edge_tts.Communicate(text=ssml, voice=edge_voice)
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
    if not MINIMAX_API_KEY:
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
        raw = resp.json()["choices"][0]["message"]["content"].strip()
        # Strip any surrounding quotes or think tags
        title = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        title = title.strip('「」『』""\'').strip()
        if not title or len(title) > 20:
            raise ValueError(f"invalid title: {title!r}")
        return {"title": title}
    except Exception as e:
        logger.warning("generate-title failed: %s", e)
        raise HTTPException(status_code=502, detail="書名生成失敗")

# ── 端點：下一幕靈感建議 ──────────────────────────────────────
class SuggestNextSceneRequest(BaseModel):
    characters: Annotated[List[Character], Field(min_length=1, max_length=6)]
    story_context: str = Field(..., min_length=1, max_length=3000)
    style: Optional[str] = Field("溫馨童趣", max_length=20)

@app.post("/api/suggest-next-scene")
async def suggest_next_scene(req: SuggestNextSceneRequest, request: Request):
    if not _rl_suggest.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    if not MINIMAX_API_KEY:
        raise HTTPException(status_code=503, detail="服務未設定")
    char_names = "、".join(c.name for c in req.characters)
    prompt = f"""你是台灣繪本故事作家。根據以下故事脈絡，為下一幕提供 3 個不同方向的場景描述建議。

角色：{char_names}
風格：{req.style}
前情脈絡：
{req.story_context}

請提供 3 個簡短的「下一幕場景描述」，每個約 20-50 字，方向各異（例如：衝突、驚喜、溫馨、冒險等）。

嚴格回傳 JSON 格式，不要任何說明：
{{"suggestions": ["描述1", "描述2", "描述3"]}}

注意：
- 使用台灣繁體中文
- 每個描述要能自然銜接前情
- 簡潔生動，適合兒童繪本"""
    try:
        resp = await _http_client.post(
            f"{MINIMAX_BASE}/chat/completions",
            headers=MINIMAX_HEADERS,
            json={
                "model": "MiniMax-M2.7",
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.8,
                "max_tokens": 400,
            },
            timeout=30,
        )
        resp.raise_for_status()
        message = resp.json()["choices"][0]["message"]
        # M2.7 thinking mode: content may be a list of blocks
        if isinstance(message["content"], list):
            raw = " ".join(
                block.get("text", "") for block in message["content"]
                if block.get("type") == "text"
            )
        else:
            raw = message["content"]
        raw = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
        logger.info("suggest-next-scene raw: %s", raw[:300])

        # Try JSON extraction first
        suggestions: list[str] = []
        m = re.search(r'\{.*\}', raw, re.DOTALL)
        if m:
            try:
                data = json.loads(m.group(0))
                suggestions = [s.strip() for s in data.get("suggestions", []) if isinstance(s, str) and s.strip()]
            except json.JSONDecodeError:
                pass

        # Fallback: extract numbered / bulleted lines as suggestions
        if not suggestions:
            lines = re.findall(r'(?:^|\n)\s*(?:\d+[.、。]|[-•*])\s*(.+)', raw)
            suggestions = [l.strip().strip('「」') for l in lines if l.strip()]

        if not suggestions:
            raise ValueError(f"could not parse suggestions from: {raw[:200]!r}")

        return {"suggestions": suggestions[:3]}
    except Exception as e:
        logger.warning("suggest-next-scene failed: %s", e)
        raise HTTPException(status_code=502, detail="靈感生成失敗")

# ── 端點：生成劇本 ────────────────────────────────────────────
@app.post("/api/generate-script", response_model=ScriptResponse)
async def generate_script(req: GenerateScriptRequest, request: Request):
    if not _rl_script.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    if not MINIMAX_API_KEY:
        raise HTTPException(status_code=503, detail="服務未正確設定，請聯絡管理員")

    character_desc = "\n".join([
        f"- {c.name}（ID: {c.id}，個性：{c.personality}，聲音類型：{c.voice_id}）"
        for c in req.characters
    ])

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
  "scene_prompt": "用英文描述這個場景的畫面，適合用來生成繪本插圖，風格為watercolor children's book illustration",
  "sfx_description": "建議的背景音效描述（例如：森林鳥鳴聲、輕柔鋼琴音樂）"
}}

注意：
- 請使用台灣繁體中文，符合台灣的語言習慣與用語，避免使用中國大陸用語
- 對話要自然有趣，適合兒童
- 每個角色至少說一句話
- 台詞不超過20字/句
- 直接輸出 JSON，不要思考過程，不要其他說明
"""

    if req.story_context:
        prompt += f"\n前情提要（請確保本幕故事自然銜接前情，劇情持續發展，不重複前幕內容）：\n{req.story_context}\n"

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
    except httpx.TimeoutException:
        raise HTTPException(status_code=504, detail="請求逾時，請稍後重試")
    except httpx.RequestError:
        raise HTTPException(status_code=502, detail="無法連線至 AI 服務，請稍後重試")

    if resp.status_code == 429:
        raise HTTPException(status_code=429, detail="API 額度不足，請至 MiniMax 平台儲值後重試")
    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail="AI 服務暫時無法使用，請稍後重試")

    try:
        resp_json = resp.json()
        logger.info("LLM response keys: %s", list(resp_json.get("choices", [{}])[0].get("message", {}).keys()))
        message = resp_json["choices"][0]["message"]
        # M2.7 thinking 模式：content 可能是 list，取 text 部分
        if isinstance(message["content"], list):
            content = " ".join(
                block.get("text", "") for block in message["content"]
                if block.get("type") == "text"
            )
        else:
            content = message["content"]
    except (KeyError, IndexError):
        raise HTTPException(status_code=502, detail="AI 服務回應格式異常")

    # 移除 <think>...</think> 思考區塊
    content = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL).strip()
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
        return ScriptResponse(**data)
    except Exception as e:
        logger.error("JSON parse failed: %s\nContent: %s", e, content[:800])
        raise HTTPException(status_code=502, detail=f"劇本解析失敗，請重試（{type(e).__name__}）")

# ── 依角色 + 情緒選擇 SSML 說話風格 ─────────────────────────────
# zh-TW 支援的風格：chat / cheerful / friendly / assistant
# 角色個性決定基調，情緒決定是否提升至更活潑的風格
_VOICE_STYLE_MAP: dict[str, dict[str, str]] = {
    # 活潑/可愛系 → 開心/驚喜時用 cheerful，平靜也偏 cheerful
    "female-tianmei-jingpin": {"happy": "cheerful", "surprised": "cheerful", "neutral": "friendly"},
    "female-shaonv":          {"happy": "cheerful", "surprised": "cheerful", "neutral": "cheerful"},
    "cute_boy":               {"happy": "cheerful", "surprised": "cheerful", "neutral": "cheerful"},
    # 成熟/優雅系 → cheerful 不誇張，平靜用 friendly
    "female-yujie":           {"happy": "friendly", "surprised": "friendly", "neutral": "friendly"},
    "female-chengshu":        {"happy": "cheerful", "surprised": "friendly", "neutral": "friendly"},
    "male-qn-jingying":       {"happy": "friendly", "surprised": "friendly", "neutral": "friendly"},
    # 老人系 → 以 friendly 為主，維持溫和感
    "elderly_man":            {"happy": "friendly", "neutral": "friendly"},
    "elderly_woman":          {"happy": "friendly", "surprised": "friendly", "neutral": "friendly"},
    # 說書/播報 → 平穩，偶爾 friendly
    "audiobook_male_2":       {"happy": "friendly", "neutral": "chat"},
    "audiobook_female_2":     {"happy": "friendly", "neutral": "friendly"},
    "presenter_male":         {"happy": "friendly", "neutral": "friendly"},
    # 青澀/霸道 → 預設 chat，開心稍升
    "male-qn-qingse":         {"happy": "cheerful", "surprised": "cheerful"},
    "male-qn-badao":          {"happy": "chat"},
}

def _get_ssml_style(voice_id: str, emotion: str) -> str:
    """Return the best SSML speaking style for this voice + emotion combo."""
    style_map = _VOICE_STYLE_MAP.get(voice_id, {})
    return style_map.get(emotion or "neutral", "chat")

# styledegree 讓風格表達更明顯（1.0 = 預設，1.3~1.5 = 更自然有感情）
_STYLE_DEGREE: dict[str, str] = {
    "cheerful": "1.4",
    "friendly": "1.3",
    "chat":     "1.2",
    "assistant":"1.1",
}

# 情緒語調：只在真正有表達意義的情緒加 pitch；
# 已有專屬風格（cheerful/friendly）的情緒不疊加 pitch，避免機械感
_EMOTION_PROSODY: dict[str, dict[str, str]] = {
    "happy":     {"rate": "+5%"},                        # cheerful 自帶高亢，不加 pitch
    "sad":       {"rate": "-10%", "pitch": "-1.5st"},    # 低沉緩慢
    "angry":     {"rate": "+8%",  "pitch": "+2st"},      # 急促高亢
    "surprised": {"rate": "+3%"},                        # 稍快即可
    "fearful":   {"rate": "-5%",  "pitch": "+1st"},      # 輕微顫抖感
    "disgusted": {"rate": "-5%",  "pitch": "-1st"},
    "neutral":   {"rate": "0%"},
}

# 插入自然停頓的標點及對應暫停時間
_PAUSE_MAP = [
    ("。", "220ms"), ("！", "180ms"), ("？", "180ms"),
    ("…", "250ms"),  ("、", "70ms"),  ("，", "90ms"),
    ("!",  "180ms"), ("?",  "180ms"), (",",  "80ms"),
]

def _build_ssml(text: str, voice: str, emotion: Optional[str], voice_id: str = "") -> str:
    """Build natural-sounding SSML: voice-appropriate style, styledegree, and punctuation pauses."""
    emo = emotion or "neutral"

    # 1. HTML-escape user text first
    safe = (text.replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace('"', "&quot;"))

    # 2. Insert natural pause breaks after punctuation (tags are safe — not user content)
    for punct, dur in _PAUSE_MAP:
        safe = safe.replace(punct, f"{punct}<break time='{dur}'/>")
    # Remove any trailing break so the sentence doesn't end with dead air
    safe = re.sub(r'(\s*<break[^/]*/>\s*)+$', '', safe).strip()

    # 3. Choose speaking style and degree
    style  = _get_ssml_style(voice_id, emo)
    degree = _STYLE_DEGREE.get(style, "1.2")

    # 4. Build prosody attributes (pitch only when explicitly defined)
    p = _EMOTION_PROSODY.get(emo, {"rate": "0%"})
    prosody_attrs = f"rate='{p['rate']}'"
    if "pitch" in p:
        prosody_attrs += f" pitch='{p['pitch']}'"

    return (
        f"<speak version='1.0' "
        f"xmlns='http://www.w3.org/2001/10/synthesis' "
        f"xmlns:mstts='https://www.w3.org/2001/mstts' "
        f"xml:lang='zh-TW'>"
        f"<voice name='{voice}'>"
        f"<mstts:express-as style='{style}' styledegree='{degree}'>"
        f"<prosody {prosody_attrs}>{safe}</prosody>"
        f"</mstts:express-as>"
        f"</voice></speak>"
    )

# ── 端點：生成語音（Edge TTS 台灣腔優先，Groq Orpheus 英文備用）───
@app.post("/api/generate-voice")
async def generate_voice(req: GenerateVoiceRequest, request: Request):
    if not _rl_voice.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    # ── 優先：Microsoft Edge TTS（台灣繁體中文 zh-TW，SSML 對話風格）─
    edge_voice = VOICE_TO_EDGE.get(req.voice_id, "zh-TW-HsiaoYuNeural")
    logger.info("TTS voice_id=%s emotion=%s → edge_voice=%s", req.voice_id, req.emotion, edge_voice)
    # Try SSML with chat style first, fall back to plain text
    for use_ssml in (True, False):
        try:
            if use_ssml:
                ssml = _build_ssml(req.text, edge_voice, req.emotion, req.voice_id)
                communicate = edge_tts.Communicate(text=ssml, voice=edge_voice)
            else:
                communicate = edge_tts.Communicate(text=req.text, voice=edge_voice)
            audio_buffer = io.BytesIO()
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    audio_buffer.write(chunk["data"])
            audio_bytes = audio_buffer.getvalue()
            if audio_bytes:
                return {"audio_base64": base64.b64encode(audio_bytes).decode("utf-8"), "format": "mp3"}
            logger.warning("Edge TTS returned empty audio (ssml=%s)", use_ssml)
        except Exception as e:
            logger.warning("Edge TTS error (ssml=%s): %s", use_ssml, e)
            if not use_ssml:
                break  # both attempts failed

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
                audio_b64 = base64.b64encode(resp.content).decode("utf-8")
                return {"audio_base64": audio_b64, "format": "wav"}
            logger.warning("Groq TTS error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("Groq TTS exception: %s", e)

    raise HTTPException(status_code=502, detail="語音生成失敗，請稍後重試")

# ── 端點：生成場景圖片（Gemini Imagen → HuggingFace → Pollinations）─
@app.post("/api/generate-image")
async def generate_image(req: GenerateImageRequest, request: Request):
    if not _rl_image.is_allowed(_client_ip(request)):
        raise HTTPException(status_code=429, detail="請求過於頻繁，請稍後再試")
    full_prompt = f"{req.prompt}, {req.style} style, soft colors, child-friendly, high quality"

    # ── 優先：Gemini Imagen 3（module-level client，避免每次重建）──
    if _gemini_client and _gemini_image_config:
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: _gemini_client.models.generate_images(
                    model="imagen-3.0-generate-002",
                    prompt=full_prompt,
                    config=_gemini_image_config,
                )
            )
            if result.generated_images:
                img_bytes = result.generated_images[0].image.image_bytes
                b64 = base64.b64encode(img_bytes).decode("utf-8")
                logger.info("Gemini Imagen success")
                return {"url": f"data:image/png;base64,{b64}"}
        except Exception as e:
            logger.warning("Gemini Imagen exception: %s", e)

    # ── 次要：HuggingFace Inference API（HUGGINGFACE_API_KEY）────
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
    # 不直接回傳外部 URL：瀏覽器無法保證能載入（CORS / 超時 / 服務不穩定），
    # 且存入 DB 後重新載入會再次依賴外部服務。fetch 後回傳 base64 才能永久可用。
    encoded = urllib.parse.quote(full_prompt)
    seed = random.randint(1, 99999)
    image_url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1024&height=768&nologo=true&seed={seed}&model=flux"
    )
    logger.info("Fallback Pollinations fetch: %s", image_url[:200])
    try:
        img_resp = await _http_client.get(image_url, timeout=90, follow_redirects=True)
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

    raise HTTPException(status_code=502, detail="插圖生成失敗，請點「重新生成插圖」再試一次")

# ── 端點：圖片辨識（Groq Vision → 繁體中文場景描述）────────────
IMAGE_MAX_BYTES = 4 * 1024 * 1024  # 4 MB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
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
    voice_id: str = Field("", max_length=64)
    color: str = Field("", max_length=20)
    emoji: str = Field("", max_length=10)

class SceneIn(BaseModel):
    idx: int = Field(..., ge=0, le=999)
    description: str = Field("", max_length=500)
    style: str = Field("溫馨童趣", max_length=20)
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
async def list_projects():
    _db_required()
    async with _db_pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT p.id, p.name, p.created_at, p.updated_at,
                   COUNT(s.id)::int AS scene_count
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
        }
        for r in rows
    ]


# ── POST /api/projects ────────────────────────────────────────
@app.post("/api/projects", status_code=201)
async def create_project(req: CreateProjectRequest):
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


# ── GET /api/projects/{project_id} ───────────────────────────
@app.get("/api/projects/{project_id}")
async def get_project(project_id: str):
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
            "SELECT id, idx, description, style, script, lines, image FROM scenes WHERE project_id = $1 ORDER BY idx",
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
async def save_project_characters(project_id: str, req: SaveCharactersRequest):
    """Persist just the characters list for a project (lightweight, no scene touch)."""
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
async def rename_project(project_id: str, req: RenameProjectRequest):
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
async def delete_project(project_id: str):
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
async def save_scenes(project_id: str, req: SaveScenesRequest):
    _db_required()
    _validate_uuid(project_id)
    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow("SELECT id FROM projects WHERE id = $1", project_id)
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")

        async with conn.transaction():
            await conn.execute("DELETE FROM scenes WHERE project_id = $1", project_id)
            if req.scenes:
                await conn.executemany(
                    """
                    INSERT INTO scenes (project_id, idx, description, style, script, lines, image)
                    VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
                    """,
                    [
                        (
                            project_id,
                            scene.idx,
                            scene.description,
                            scene.style,
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
                    characters = $1::jsonb
                WHERE id = $2
                """,
                json.dumps([c.model_dump() for c in req.characters], ensure_ascii=False),
                project_id,
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


def _export_pdf(project_name: str, scenes: list) -> bytes:
    try:
        from fpdf import FPDF
    except ImportError:
        raise HTTPException(status_code=501, detail="fpdf2 未安裝，PDF 匯出不可用")

    font_path = _find_cjk_font()

    pdf = FPDF(orientation="P", unit="mm", format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)

    # Register CJK font if available
    use_cjk = font_path is not None
    if use_cjk:
        pdf.add_font("NotoSansCJK", "", font_path, uni=True)

    def set_font_safe(size: int, style: str = ""):
        if use_cjk:
            pdf.set_font("NotoSansCJK", style=style, size=size)
        else:
            pdf.set_font("Helvetica", style=style, size=size)

    # Cover page
    pdf.add_page()
    set_font_safe(28, "B")
    pdf.set_y(100)
    pdf.cell(0, 14, project_name, align="C", new_x="LMARGIN", new_y="NEXT")
    set_font_safe(12)
    pdf.cell(0, 10, "繪本有聲書", align="C")

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
                # Keep image within page, max height 80mm
                img_h = min(80, 297 - current_y - 50)
                if img_h > 10:
                    pdf.image(tmp_path, x=10, y=current_y, w=190, h=img_h)
                    current_y += img_h + 4
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

        set_font_safe(10)
        for line in lines:
            char_name = line.get("character_name", "")
            text = line.get("text", "")
            pdf.set_xy(10, current_y)
            pdf.multi_cell(190, 7, f"{char_name}：{text}")
            current_y = pdf.get_y() + 2

    return pdf.output()


def _export_epub(project_name: str, scenes: list) -> bytes:
    try:
        from ebooklib import epub
    except ImportError:
        raise HTTPException(status_code=501, detail="ebooklib 未安裝，EPUB 匯出不可用")

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
.char-name { font-weight: bold; color: #764ba2; white-space: nowrap; width: 6em; }
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

        # Build dialogue HTML — escape user-supplied text to prevent XSS in XHTML
        dialogue_rows = ""
        for line in lines:
            char_name = html.escape(line.get("character_name", ""))
            text = html.escape(line.get("text", ""))
            dialogue_rows += f'<tr><td class="char-name">{char_name}</td><td class="dialogue-text">{text}</td></tr>'

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


def _export_html_zip(project_name: str, scenes: list) -> bytes:
    # Build a self-contained index.html with all scenes
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
            char_name = html.escape(line.get("character_name", ""))
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
            line_divs += f"""
        <div class="dialogue-line" id="line-{i}-{j}">
          <span class="char-name">{char_name}</span>
          <span class="dialogue-text">{text}</span>
          {audio_tag}
        </div>"""

        scene_htmls.append(f"""
  <section class="scene-card" id="scene-{i}">
    <h2 class="scene-title">第{i+1}幕</h2>
    <p class="scene-desc">{desc}</p>
    {img_tag}
    <div class="dialogue-block">{line_divs}
    </div>
  </section>""")

    scenes_joined = "\n".join(scene_htmls)

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
    .dialogue-line {{ display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: #fafbff; border-radius: 10px; padding: 10px 14px; border-left: 4px solid #667eea; }}
    .char-name {{ font-weight: 700; color: #764ba2; white-space: nowrap; min-width: 4em; }}
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
      color: white; padding: 12px 20px;
      display: flex; align-items: center; gap: 14px;
      box-shadow: 0 -4px 20px rgba(0,0,0,0.18);
      z-index: 999; font-family: 'Microsoft JhengHei', 'Noto Sans TC', sans-serif;
    }}
    #player-bar.hidden {{ display: none; }}
    #btn-play-all {{
      background: linear-gradient(135deg,#43e97b,#38f9d7);
      border: none; border-radius: 24px; padding: 8px 22px;
      font-weight: 800; font-size: 1rem; color: white;
      cursor: pointer; white-space: nowrap; transition: opacity .15s;
    }}
    #btn-play-all:hover {{ opacity: .85; }}
    #player-now {{ flex: 1; font-size: 0.92rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .92; }}
    #player-progress {{ font-size: 0.8rem; opacity: .7; white-space: nowrap; }}
    /* header launch button */
    .header-play-btn {{
      margin-top: 14px; background: white; color: #667eea;
      border: none; border-radius: 28px; padding: 10px 28px;
      font-weight: 800; font-size: 1rem; cursor: pointer;
      transition: box-shadow .15s;
    }}
    .header-play-btn:hover {{ box-shadow: 0 4px 16px rgba(0,0,0,.18); }}
  </style>
</head>
<body>
  <header>
    <h1>{escaped_project_name}</h1>
    <p>繪本有聲書互動版</p>
    <button class="header-play-btn" onclick="startPlayAll()">▶ 播放全書</button>
  </header>
  <main>
{scenes_joined}
  </main>
  <footer>由「繪本有聲書創作工坊」匯出</footer>

  <!-- Sticky player bar (hidden until Play All starts) -->
  <div id="player-bar" class="hidden">
    <button id="btn-play-all" onclick="togglePlayAll()">⏸ 暫停</button>
    <span id="player-now">準備播放...</span>
    <span id="player-progress"></span>
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

    function _buildPlaylist() {{
      var items = [];
      document.querySelectorAll('.dialogue-line').forEach(function(el) {{
        var audio = el.querySelector('audio');
        if (!audio) return;
        items.push({{
          audioId: audio.id,
          lineId: el.id,
          charName: (el.querySelector('.char-name') || {{}}).textContent || '',
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

      var audio = document.getElementById(item.audioId);
      if (!audio) {{ _advance(); return; }}
      audio.currentTime = 0;
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

    // keyboard shortcuts: Space = toggle, Esc = stop
    document.addEventListener('keydown', function(e) {{
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.code === 'Space') {{ e.preventDefault(); togglePlayAll(); }}
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

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("index.html", html_doc.encode("utf-8"))
    return buf.getvalue()


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
                readme_lines.append(f"  行{j+1:02d} {char_name}：{text}")
                if audio_b64:
                    try:
                        audio_bytes = base64.b64decode(audio_b64)
                        # Sanitise char_name for filename
                        safe_name = re.sub(r'[\\/:*?"<>|]', "_", char_name)
                        filename = f"{folder}/{folder}_行{j+1:02d}_{safe_name}.mp3"
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
    project_id: str,
    format: _EXPORT_FORMAT = "pdf",
):
    _db_required()
    _validate_uuid(project_id)

    # Load project from DB
    async with _db_pool.acquire() as conn:
        proj = await conn.fetchrow(
            "SELECT id, name FROM projects WHERE id = $1", project_id
        )
        if proj is None:
            raise HTTPException(status_code=404, detail="專案不存在")
        scene_rows = await conn.fetch(
            "SELECT idx, description, style, lines, image FROM scenes "
            "WHERE project_id = $1 ORDER BY idx",
            project_id,
        )

    project_name = proj["name"]
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

    if format == "pdf":
        data = _export_pdf(project_name, scenes)
        media_type = "application/pdf"
        filename = f"{project_name}.pdf"
    elif format == "epub":
        data = _export_epub(project_name, scenes)
        media_type = "application/epub+zip"
        filename = f"{project_name}.epub"
    elif format == "html":
        data = _export_html_zip(project_name, scenes)
        media_type = "application/zip"
        filename = f"{project_name}_web.zip"
    else:  # "mp3"
        data = _export_mp3_zip(project_name, scenes)
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
