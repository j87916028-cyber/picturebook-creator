"""Smoke tests for the picturebook-creator backend.

Run:  cd backend && pip install pytest && pytest test_smoke.py -v

These tests use FastAPI's TestClient (synchronous wrapper over httpx)
so they don't need a running server or database.  They verify:
1. The app starts without import errors (catches module-split regressions)
2. Key endpoints return expected status codes
3. Pydantic validation rejects malformed input
4. Export function imports resolve correctly
"""
import pytest
from fastapi.testclient import TestClient

from main import app


@pytest.fixture(scope="module")
def client():
    """Shared test client — created once per module for speed."""
    with TestClient(app) as c:
        yield c


# ── Health & discovery ────────────────────────────────────────

def test_health(client: TestClient):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "services" in body


def test_voices_list(client: TestClient):
    r = client.get("/api/voices")
    assert r.status_code == 200
    voices = r.json()
    assert isinstance(voices, list)
    assert len(voices) > 0
    assert "id" in voices[0]
    assert "label" in voices[0]


# ── Input validation (no API keys needed) ─────────────────────

def test_generate_script_empty_body(client: TestClient):
    r = client.post("/api/generate-script", json={})
    assert r.status_code == 422


def test_generate_script_missing_characters(client: TestClient):
    r = client.post("/api/generate-script", json={
        "scene_description": "A rabbit in the forest",
    })
    assert r.status_code == 422


def test_generate_voice_empty_text(client: TestClient):
    r = client.post("/api/generate-voice", json={
        "text": "",
        "voice_id": "cn-natural-female",
    })
    assert r.status_code == 422


def test_generate_voice_invalid_voice(client: TestClient):
    r = client.post("/api/generate-voice", json={
        "text": "hello",
        "voice_id": "nonexistent-voice-id-12345",
    })
    # Should fail validation or return 404
    assert r.status_code in (404, 422)


def test_generate_image_missing_prompt(client: TestClient):
    r = client.post("/api/generate-image", json={})
    assert r.status_code == 422


def test_recognize_image_no_file(client: TestClient):
    r = client.post("/api/recognize-image")
    assert r.status_code == 422


# ── Project CRUD (requires DB — skip if unavailable) ──────────

def test_projects_list_no_db(client: TestClient):
    r = client.get("/api/projects")
    # 503 if no DB, 200 if DB connected
    assert r.status_code in (200, 503)


def test_project_invalid_uuid(client: TestClient):
    r = client.get("/api/projects/not-a-uuid")
    # 400 (invalid UUID) if DB connected; 503 (no DB) if _db_required fires first
    assert r.status_code in (400, 503)


def test_export_invalid_uuid(client: TestClient):
    r = client.get("/api/projects/not-a-uuid/export?format=pdf")
    assert r.status_code in (400, 503)


# ── Export module imports ─────────────────────────────────────

def test_export_imports():
    """Verify exports.py functions are importable (catches module-split regressions)."""
    from exports import (
        _safe_css_color, _SAFE_CSS_COLOR_RE,
        _export_pdf, _export_epub, _export_html,
        _export_mp3_zip, _export_txt, _export_srt,
        _export_md, _export_images_zip, _export_json_backup,
    )
    assert callable(_export_pdf)
    assert callable(_export_html)
    assert _safe_css_color("#abc") == "#abc"
    assert _safe_css_color("red") == "#667eea"
    assert _safe_css_color("#12345") == "#667eea"  # invalid 5-digit
    assert _SAFE_CSS_COLOR_RE.match("#abcdef")


# ── Response headers ──────────────────────────────────────────

def test_security_headers(client: TestClient):
    r = client.get("/api/health")
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert r.headers.get("X-Frame-Options") == "DENY"
    assert "X-Response-Time" in r.headers


def test_voices_cache_control(client: TestClient):
    r = client.get("/api/voices")
    assert "max-age" in r.headers.get("Cache-Control", "")


# ── Export function output tests (pure functions, no DB/API) ──

_SAMPLE_SCENES = [
    {
        "idx": 0,
        "title": "開場",
        "description": "兔子在森林裡",
        "style": "溫馨童趣",
        "line_length": "standard",
        "image_style": "",
        "mood": "",
        "age_group": "child",
        "is_locked": False,
        "notes": "",
        "scene_prompt": "a rabbit in a forest",
        "sfx_description": "鳥鳴聲",
        "lines": [
            {"character_name": "小白兔", "character_id": "c1", "voice_id": "cn-natural-female", "text": "好暗喔", "emotion": "fearful"},
            {"character_name": "小狐狸", "character_id": "c2", "voice_id": "cn-natural-male", "text": "別怕！", "emotion": "happy"},
        ],
        "image": "",
    }
]
_SAMPLE_CHARS = [
    {"id": "c1", "name": "小白兔", "personality": "膽小", "emoji": "🐰", "color": "#FF6B6B"},
    {"id": "c2", "name": "小狐狸", "personality": "勇敢", "emoji": "🦊", "color": "#4ECDC4"},
]


def test_export_txt():
    from exports import _export_txt
    data = _export_txt("測試故事", _SAMPLE_SCENES, _SAMPLE_CHARS)
    assert isinstance(data, bytes)
    text = data.decode("utf-8")
    assert "小白兔" in text
    assert "好暗喔" in text
    assert "測試故事" in text


def test_export_md():
    from exports import _export_md
    data = _export_md("測試故事", _SAMPLE_SCENES, _SAMPLE_CHARS)
    text = data.decode("utf-8")
    assert "# 《測試故事》" in text
    assert "小狐狸" in text


def test_export_srt():
    from exports import _export_srt
    data = _export_srt("測試故事", _SAMPLE_SCENES)
    text = data.decode("utf-8")
    assert "-->" in text  # SRT timestamp arrow
    assert "好暗喔" in text


def test_export_json_backup():
    from exports import _export_json_backup
    import json
    data = _export_json_backup("測試故事", _SAMPLE_SCENES, _SAMPLE_CHARS)
    parsed = json.loads(data)
    assert parsed["name"] == "測試故事"
    assert parsed["version"] == 1
    assert len(parsed["scenes"]) == 1
    assert len(parsed["characters"]) == 2


def test_export_html():
    from exports import _export_html
    data = _export_html("測試故事", _SAMPLE_SCENES, characters=_SAMPLE_CHARS)
    html_str = data.decode("utf-8")
    assert "<html" in html_str
    assert "小白兔" in html_str
    assert "好暗喔" in html_str


def test_export_images_zip_empty():
    from exports import _export_images_zip
    data = _export_images_zip("測試故事", _SAMPLE_SCENES)
    assert isinstance(data, bytes)
    assert len(data) > 0  # should contain at least the README
