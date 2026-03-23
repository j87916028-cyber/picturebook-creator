import os
import re
import json
import base64
import httpx
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
from fastapi import FastAPI, HTTPException, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Annotated
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(title="Picturebook Creator API")

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
    allow_methods=["GET", "POST"],
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

# ── 端點：生成劇本 ────────────────────────────────────────────
@app.post("/api/generate-script", response_model=ScriptResponse)
async def generate_script(req: GenerateScriptRequest):
    if not MINIMAX_API_KEY:
        raise HTTPException(status_code=503, detail="服務未正確設定，請聯絡管理員")

    character_desc = "\n".join([
        f"- {c.name}（ID: {c.id}，個性：{c.personality}，聲音類型：{c.voice_id}）"
        for c in req.characters
    ])

    prompt = f"""你是一位繪本故事作家。請根據以下場景和角色，生成一段繪本對話劇本。

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
- 對話要自然有趣，適合兒童
- 每個角色至少說一句話
- 台詞不超過20字/句
- 直接輸出 JSON，不要思考過程，不要其他說明
"""

    if req.story_context:
        prompt += f"\n前情提要（請確保本幕故事自然銜接前情，劇情持續發展，不重複前幕內容）：\n{req.story_context}\n"

    try:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(
                f"{MINIMAX_BASE}/chat/completions",
                headers=MINIMAX_HEADERS,
                json={
                    "model": "MiniMax-M2.7",
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.8,
                },
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

# ── 端點：生成語音（Groq Orpheus TTS → edge-tts fallback）───
@app.post("/api/generate-voice")
async def generate_voice(req: GenerateVoiceRequest):
    groq_voice = VOICE_TO_GROQ.get(req.voice_id, "diana")
    logger.info("TTS voice_id=%s → groq_voice=%s", req.voice_id, groq_voice)

    # ── 優先：Groq Orpheus ────────────────────────────────────
    if GROQ_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=30) as client:
                resp = await client.post(
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
                )
            if resp.status_code == 200 and resp.content:
                audio_b64 = base64.b64encode(resp.content).decode("utf-8")
                return {"audio_base64": audio_b64, "format": "wav"}
            logger.warning("Groq TTS error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("Groq TTS exception: %s", e)

    # ── 備用：Microsoft Edge TTS（中文）──────────────────────
    import io
    import edge_tts

    VOICE_TO_EDGE = {
        "female-tianmei-jingpin": "zh-TW-HsiaoYuNeural",
        "female-shaonv":          "zh-CN-XiaoxiaoNeural",
        "female-yujie":           "zh-CN-XiaohanNeural",
        "female-chengshu":        "zh-TW-HsiaoChenNeural",
        "male-qn-qingse":         "zh-CN-YunxiNeural",
        "male-qn-jingying":       "zh-CN-YunyangNeural",
        "male-qn-badao":          "zh-CN-YunjianNeural",
        "presenter_male":         "zh-CN-YunyangNeural",
        "audiobook_male_2":       "zh-CN-YunxiNeural",
        "audiobook_female_2":     "zh-CN-XiaomoNeural",
        "cute_boy":               "zh-CN-XiaoxiaoNeural",
        "elderly_man":            "zh-CN-YunyangNeural",
        "elderly_woman":          "zh-TW-HsiaoChenNeural",
    }
    edge_voice = VOICE_TO_EDGE.get(req.voice_id, "zh-TW-HsiaoYuNeural")
    logger.info("Fallback edge-tts voice: %s", edge_voice)
    try:
        communicate = edge_tts.Communicate(text=req.text, voice=edge_voice)
        audio_buffer = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                audio_buffer.write(chunk["data"])
        audio_bytes = audio_buffer.getvalue()
        if audio_bytes:
            return {"audio_base64": base64.b64encode(audio_bytes).decode("utf-8"), "format": "mp3"}
    except Exception as e:
        logger.error("Edge TTS fallback error: %s", e)

    raise HTTPException(status_code=502, detail="語音生成失敗，請稍後重試")

# ── 端點：生成場景圖片（HuggingFace FLUX / Pollinations fallback）─
@app.post("/api/generate-image")
async def generate_image(req: GenerateImageRequest):
    import urllib.parse
    import random

    full_prompt = f"{req.prompt}, {req.style} style, soft colors, child-friendly, high quality"

    # ── 優先：HuggingFace Inference API（需 HUGGINGFACE_API_KEY）──
    if HUGGINGFACE_API_KEY:
        hf_headers = {
            "Authorization": f"Bearer {HUGGINGFACE_API_KEY}",
            "Content-Type": "application/json",
        }
        try:
            async with httpx.AsyncClient(timeout=60) as client:
                resp = await client.post(
                    HF_INFERENCE_URL,
                    headers=hf_headers,
                    json={"inputs": full_prompt},
                )
            if resp.status_code == 200 and resp.content:
                b64 = base64.b64encode(resp.content).decode("utf-8")
                mime = resp.headers.get("content-type", "image/jpeg").split(";")[0]
                return {"url": f"data:{mime};base64,{b64}"}
            logger.warning("HF image error %s: %s", resp.status_code, resp.text[:200])
        except Exception as e:
            logger.warning("HF image exception: %s", e)

    # ── 備用：Pollinations.ai URL（瀏覽器直接載入）──────────────
    encoded = urllib.parse.quote(full_prompt)
    seed = random.randint(1, 99999)
    image_url = (
        f"https://image.pollinations.ai/prompt/{encoded}"
        f"?width=1024&height=768&nologo=true&seed={seed}"
    )
    logger.info("Fallback image URL: %s", image_url[:200])
    return {"url": image_url}

# ── 端點：圖片辨識（Groq Vision → 繁體中文場景描述）────────────
IMAGE_MAX_BYTES = 4 * 1024 * 1024  # 4 MB
ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
IMAGE_DESCRIBE_PROMPT = (
    "請用繁體中文描述這張圖片的場景內容，100字以內，適合作為兒童繪本的場景描述。"
)

@app.post("/api/recognize-image")
async def recognize_image(file: UploadFile = File(...)):
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
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                GROQ_CHAT_URL,
                headers={
                    "Authorization": f"Bearer {GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json=payload,
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
async def transcribe_audio(file: UploadFile = File(...)):
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
        async with httpx.AsyncClient(timeout=120) as client:
            resp = await client.post(
                GROQ_TRANSCRIBE_URL,
                headers={"Authorization": f"Bearer {GROQ_API_KEY}"},
                files={"file": (filename, data, content_type)},
                data={
                    "model": "whisper-large-v3-turbo",
                    "language": "zh",
                    "response_format": "json",
                },
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


# ── 健康檢查 ──────────────────────────────────────────────────
@app.get("/api/health")
def health():
    return {"status": "ok"}
