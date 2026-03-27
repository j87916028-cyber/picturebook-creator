"""Export functions for picturebook-creator.

Extracted from main.py to improve navigability (~1700 lines).
All functions are pure (no FastAPI/DB dependencies) — they accept
data dicts and return bytes.
"""
import base64
import glob as _glob
import html
import io
import json
import logging
import math
import os
import re
import struct
import tempfile
import zipfile
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger("picturebook.exports")

# ── Shared CSS color validation ──────────────────────────────────
_SAFE_CSS_COLOR_RE = re.compile(
    r'^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$'
)

def _safe_css_color(color: str, fallback: str = "#667eea") -> str:
    """Validate a CSS hex color; return fallback if it doesn't look safe."""
    return color if _SAFE_CSS_COLOR_RE.match(color or "") else fallback

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


def _export_pdf(
    project_name: str,
    scenes: list,
    char_color_map: dict | None = None,
    characters: list | None = None,
) -> bytes:
    try:
        from fpdf import FPDF
    except ImportError:
        raise HTTPException(status_code=501, detail="fpdf2 未安裝，PDF 匯出不可用")

    if char_color_map is None:
        char_color_map = {}
    if characters is None:
        characters = []

    font_path = _find_cjk_font()
    _use_cjk = font_path is not None

    # Determine how many front-matter pages (cover ± character intro) precede the story.
    # Updated below after deciding whether to emit the character page.
    _front_pages = 1  # default: cover only

    class _PicturebookPDF(FPDF):
        """FPDF subclass that adds centered page numbers in the footer.

        Front-matter pages (cover, character intro) have no footer.
        Scene pages are numbered starting from "第 1 頁".
        """
        def footer(self) -> None:
            nonlocal _front_pages
            if self.page <= _front_pages:   # front-matter — no footer
                return
            self.set_y(-10)
            # Footer always uses regular weight to keep it subtle.
            if _use_cjk:
                self.set_font("NotoSansCJK", style="", size=8)
            else:
                self.set_font("Helvetica", style="", size=8)
            self.set_text_color(160, 160, 160)
            # page_no() counts from 1; subtract front-matter pages so scenes start at 1.
            self.cell(0, 5, f"— 第 {self.page_no() - _front_pages} 頁 —", align="C")
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

    # Cover illustration — use the first scene's image if available.
    # Renders it at the top of the page (full-width, up to 110 mm tall) so the
    # PDF looks like a real picture book rather than a plain text document.
    cover_img_y_end = 0  # tracks how far down the image reaches
    cover_image_data = next(
        (s.get("image", "") for s in scenes if s.get("image") and s["image"] != "error"),
        "",
    )
    if cover_image_data and cover_image_data.startswith("data:"):
        try:
            header, b64data = cover_image_data.split(",", 1)
            img_ext = header.split("/")[1].split(";")[0]
            if img_ext == "jpeg":
                img_ext = "jpg"
            img_bytes = base64.b64decode(b64data)
            with tempfile.NamedTemporaryFile(suffix=f".{img_ext}", delete=False) as tmp:
                tmp.write(img_bytes)
                tmp_path = tmp.name
            try:
                img_h = 110  # mm — generous height so the illustration dominates
                pdf.image(tmp_path, x=10, y=15, w=190, h=img_h)
                cover_img_y_end = 15 + img_h + 6  # 6 mm gap below image
            finally:
                os.unlink(tmp_path)
        except Exception as e:
            logger.warning("PDF cover image embed failed: %s", e)

    # Title — place below the cover image (or centred in the top half if no image)
    title_y = cover_img_y_end if cover_img_y_end else 90
    set_font_safe(28, "B")
    pdf.set_y(title_y)
    pdf.cell(0, 14, project_name, align="C", new_x="LMARGIN", new_y="NEXT")

    set_font_safe(12)
    pdf.cell(0, 10, "繪本有聲書", align="C", new_x="LMARGIN", new_y="NEXT")

    # ── Story metadata ──────────────────────────────────────────────────
    all_lines = [ln for s in scenes for ln in s.get("lines", [])]
    total_lines = len(all_lines)
    # Estimate listening time the same way the frontend does: ~4 Chinese chars/second.
    total_chars = sum(len(ln.get("text", "")) for ln in all_lines)
    audio_secs  = total_chars // 4
    set_font_safe(10)
    pdf.set_text_color(120, 120, 120)
    pdf.ln(6)
    pdf.cell(0, 7, f"共 {len(scenes)} 幕  ·  {total_lines} 句台詞  ·  {total_chars} 字", align="C",
             new_x="LMARGIN", new_y="NEXT")
    if audio_secs >= 5:
        mins = audio_secs // 60
        secs = audio_secs % 60
        time_str = (
            f"預估聆聽時長：約 {mins} 分 {secs:02d} 秒"
            if mins > 0
            else f"預估聆聽時長：約 {secs} 秒"
        )
        set_font_safe(9)
        pdf.cell(0, 6, time_str, align="C", new_x="LMARGIN", new_y="NEXT")
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

    # ── Character introduction page ──────────────────────────────────────
    # Only emit when at least one character has a name + personality.
    chars_with_info = [
        c for c in characters
        if c.get("name") and (c.get("personality") or c.get("portrait_url"))
    ][:6]  # cap at 6 to keep the page uncluttered

    if chars_with_info:
        _front_pages = 2  # cover + character intro
        pdf.add_page()
        set_font_safe(18, "B")
        pdf.set_y(18)
        pdf.cell(0, 12, "登場角色", align="C", new_x="LMARGIN", new_y="NEXT")

        portrait_size = 28   # mm — portrait thumbnail width/height
        row_h        = 34    # mm — total row height (portrait + some padding)
        left_margin  = 18    # mm
        text_x       = left_margin + portrait_size + 6   # mm — start of text column
        text_w       = 210 - text_x - left_margin        # available width for text

        current_y = pdf.get_y() + 4

        for char in chars_with_info:
            raw_name        = char.get("name", "")
            raw_personality = char.get("personality", "")
            portrait_url    = char.get("portrait_url", "") or ""
            color_hex       = _safe_css_color(char_color_map.get(raw_name, ""), fallback="")
            char_rgb        = _hex_to_rgb(color_hex) if color_hex else None

            # Check page overflow before drawing each character
            if current_y + row_h > 280:
                pdf.add_page()
                _front_pages += 1
                current_y = 20

            # Try to render portrait thumbnail
            portrait_ok = False
            if portrait_url.startswith("data:"):
                try:
                    hdr, b64data = portrait_url.split(",", 1)
                    img_ext = hdr.split("/")[1].split(";")[0]
                    if img_ext == "jpeg":
                        img_ext = "jpg"
                    img_bytes = base64.b64decode(b64data)
                    with tempfile.NamedTemporaryFile(suffix=f".{img_ext}", delete=False) as tmp:
                        tmp.write(img_bytes)
                        tmp_path = tmp.name
                    try:
                        pdf.image(tmp_path, x=left_margin, y=current_y, w=portrait_size, h=portrait_size)
                        portrait_ok = True
                    finally:
                        os.unlink(tmp_path)
                except Exception:
                    pass  # fall through to emoji placeholder

            if not portrait_ok:
                # Draw a colored rectangle as placeholder, with emoji text centred in it
                if char_rgb:
                    pdf.set_fill_color(*char_rgb)
                else:
                    pdf.set_fill_color(220, 220, 220)
                pdf.rect(left_margin, current_y, portrait_size, portrait_size, style="F")
                pdf.set_fill_color(255, 255, 255)
                emoji_char = char.get("emoji", "")
                if emoji_char:
                    set_font_safe(14)
                    pdf.set_xy(left_margin, current_y + portrait_size / 2 - 5)
                    pdf.cell(portrait_size, 10, emoji_char, align="C")

            # Character name
            pdf.set_xy(text_x, current_y + 4)
            set_font_safe(13, "B")
            if char_rgb:
                pdf.set_text_color(*char_rgb)
            pdf.multi_cell(text_w, 8, raw_name)
            pdf.set_text_color(0, 0, 0)

            # Personality description
            if raw_personality:
                set_font_safe(10)
                pdf.set_xy(text_x, pdf.get_y() + 1)
                pdf.set_text_color(80, 80, 80)
                pdf.multi_cell(text_w, 6, raw_personality)
                pdf.set_text_color(0, 0, 0)

            current_y += row_h + 2

    # Scene pages
    for i, scene in enumerate(scenes):
        pdf.add_page()
        current_y = 15

        # Title
        scene_title = scene.get("title", "").strip()
        set_font_safe(16, "B")
        pdf.set_xy(10, current_y)
        title_text = f"第{i + 1}幕" + (f"  {scene_title}" if scene_title else "")
        pdf.cell(0, 10, title_text, align="L", new_x="LMARGIN", new_y="NEXT")
        current_y += 12

        # Description
        desc = scene.get("description", "")
        if desc:
            set_font_safe(10)
            pdf.set_xy(10, current_y)
            pdf.multi_cell(190, 6, desc)
            current_y = pdf.get_y() + 2

        # SFX hint
        sfx = scene.get("sfx_description", "").strip()
        if sfx:
            set_font_safe(8)
            pdf.set_text_color(124, 111, 159)
            pdf.set_xy(10, current_y)
            pdf.multi_cell(190, 5, f"🎵 音效建議：{sfx}")
            pdf.set_text_color(0, 0, 0)
            current_y = pdf.get_y() + 4
        else:
            current_y += 2

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


def _export_epub(project_name: str, scenes: list, char_color_map: dict | None = None, project_id: str | None = None, characters: list | None = None) -> bytes:
    try:
        from ebooklib import epub
    except ImportError:
        raise HTTPException(status_code=501, detail="ebooklib 未安裝，EPUB 匯出不可用")

    if char_color_map is None:
        char_color_map = {}
    if characters is None:
        characters = []

    book = epub.EpubBook()
    book.set_title(project_name)
    book.set_language("zh-TW")
    # Use the project UUID when available — it is stable across container restarts
    # (unlike hash(), which is randomised by PYTHONHASHSEED) and globally unique.
    # The urn:uuid: prefix is the EPUB3 standard format for UUID identifiers.
    # Fall back to an MD5-based identifier so exports still work without a project_id
    # (e.g. in tests or if the function is called directly).
    if project_id:
        book.set_identifier(f"urn:uuid:{project_id}")
    else:
        stable_hash = hashlib.md5(project_name.encode()).hexdigest()[:16]
        book.set_identifier(f"picturebook-{stable_hash}")

    css_content = """
body { font-family: 'Noto Sans CJK TC', 'Microsoft JhengHei', sans-serif; margin: 2em; line-height: 1.8; color: #333; }
h1 { color: #667eea; font-size: 1.4em; border-bottom: 2px solid #667eea; padding-bottom: 0.3em; }
.scene-desc { font-style: italic; color: #666; margin: 0.8em 0 0.4em 0; font-size: 0.95em; }
.scene-sfx { display: inline-block; font-size: 0.8em; color: #7c6f9f; font-style: italic; background: #f8f5ff; border: 1px solid #e8e0ff; border-radius: 20px; padding: 3px 12px; margin-bottom: 0.8em; }
.dialogue-table { width: 100%; border-collapse: collapse; margin: 1em 0; }
.dialogue-table td { padding: 8px 12px; vertical-align: top; }
.char-name { font-weight: bold; white-space: nowrap; width: 6em; }
.dialogue-text { color: #333; }
.line-audio { display: block; margin-top: 4px; width: 100%; max-width: 260px; height: 32px; }
.scene-image { max-width: 100%; border-radius: 8px; margin: 1em auto; display: block; }
.char-intro-title { color: #667eea; font-size: 1.3em; border-bottom: 2px solid #667eea; padding-bottom: 0.3em; }
.char-intro-grid { display: block; }
.char-intro-card { border: 1px solid #e0e0e0; border-radius: 10px; padding: 1em; margin: 0.8em 0; border-top-width: 4px; }
.char-intro-emoji { font-size: 2em; margin-bottom: 0.2em; }
.char-intro-portrait { width: 56px; height: 56px; border-radius: 50%; object-fit: cover; display: block; margin-bottom: 0.5em; }
.char-intro-name { font-size: 1.1em; font-weight: bold; margin-bottom: 0.3em; }
.char-intro-personality { font-size: 0.9em; color: #555; line-height: 1.6; }
"""
    nav_css = epub.EpubItem(uid="style_nav", file_name="style/nav.css", media_type="text/css", content=css_content)
    book.add_item(nav_css)

    chapters = []

    # ── Character introduction chapter ──────────────────────────────────────
    eligible_chars = [
        c for c in characters
        if c.get("name") and (c.get("personality") or c.get("portrait_url"))
    ]
    if eligible_chars:
        char_cards_xhtml = ""
        for ci, c in enumerate(eligible_chars):
            name        = html.escape(str(c.get("name", "")))
            emoji       = html.escape(str(c.get("emoji", "🎭")))
            personality = html.escape(str(c.get("personality", "")))
            color       = _safe_css_color(c.get("color", ""), fallback="#667eea")
            portrait_url = c.get("portrait_url", "")

            # Embed portrait image if it's a data URI
            portrait_html = ""
            if portrait_url and portrait_url.startswith("data:"):
                try:
                    hdr, b64data = portrait_url.split(",", 1)
                    mime = hdr.split(";")[0].replace("data:", "")
                    ext = mime.split("/")[1]
                    if ext == "jpeg":
                        ext = "jpg"
                    port_bytes = base64.b64decode(b64data)
                    port_item = epub.EpubItem(
                        uid=f"char_portrait_{ci}",
                        file_name=f"images/char_portrait_{ci}.{ext}",
                        media_type=mime,
                        content=port_bytes,
                    )
                    book.add_item(port_item)
                    portrait_html = f'<img src="../images/char_portrait_{ci}.{ext}" class="char-intro-portrait" alt="{name}"/>'
                except Exception as e:
                    logger.warning("EPUB char portrait embed failed: %s", e)

            avatar_html = portrait_html if portrait_html else f'<div class="char-intro-emoji">{emoji}</div>'
            personality_html = f'<div class="char-intro-personality">{personality}</div>' if personality else ""
            char_cards_xhtml += f"""
  <div class="char-intro-card" style="border-top-color:{color}">
    {avatar_html}
    <div class="char-intro-name" style="color:{color}">{name}</div>
    {personality_html}
  </div>"""

        char_intro_content = f"""<?xml version='1.0' encoding='utf-8'?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
<head>
  <title>認識角色</title>
  <link rel="stylesheet" type="text/css" href="../style/nav.css"/>
</head>
<body>
  <h1 class="char-intro-title">✨ 認識角色</h1>
  <div class="char-intro-grid">{char_cards_xhtml}
  </div>
</body>
</html>"""
        char_intro_chapter = epub.EpubHtml(title="認識角色", file_name="scenes/char_intro.xhtml", lang="zh-TW")
        char_intro_chapter.content = char_intro_content
        char_intro_chapter.add_item(nav_css)
        book.add_item(char_intro_chapter)
        chapters.append(char_intro_chapter)

    for i, scene in enumerate(scenes):
        desc = html.escape(scene.get("description", ""))
        sfx = html.escape(scene.get("sfx_description", "").strip())
        epub_scene_title = html.escape(scene.get("title", "").strip())
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

        # Build dialogue HTML with inline audio — escape user-supplied text to
        # prevent XSS in XHTML.  Per-character accent colour uses direct color
        # values (CSS custom properties are not reliable across EPUB readers).
        # Audio <audio> elements are placed inside each dialogue row so readers
        # can play each line right where they read it, rather than scrolling to
        # a separate audio section at the bottom of the chapter.
        dialogue_rows = ""
        for j, line in enumerate(lines):
            raw_char_name = line.get("character_name", "")
            char_name = html.escape(raw_char_name)
            text = html.escape(line.get("text", ""))
            char_color = _safe_css_color(char_color_map.get(raw_char_name, ""))

            # Inline audio — embed the audio file and add a compact player tag
            inline_audio = ""
            audio_b64 = line.get("audio_base64")
            if audio_b64:
                try:
                    audio_bytes = base64.b64decode(audio_b64)
                    # audio_format is "mp3" for iFlytek/Edge TTS and "wav" for
                    # Groq Orpheus.  Wrong MIME type → silent failure in readers.
                    audio_fmt = (line.get("audio_format") or "mp3").lower()
                    mime_type = "audio/mpeg" if audio_fmt == "mp3" else f"audio/{audio_fmt}"
                    audio_fname = f"audio/scene{i}_line{j}.{audio_fmt}"
                    audio_item = epub.EpubItem(
                        uid=f"audio_{i}_{j}",
                        file_name=audio_fname,
                        media_type=mime_type,
                        content=audio_bytes,
                    )
                    book.add_item(audio_item)
                    inline_audio = (
                        f'<audio class="line-audio" controls="controls" src="../{audio_fname}">'
                        f'</audio>'
                    )
                except Exception as e:
                    logger.warning("EPUB audio embed failed: %s", e)

            dialogue_rows += (
                f'<tr>'
                f'<td class="char-name" style="color:{char_color}">{char_name}</td>'
                f'<td class="dialogue-text">{text}{inline_audio}</td>'
                f'</tr>'
            )

        dialogue_html = ""
        if dialogue_rows:
            dialogue_html = f'<table class="dialogue-table"><tbody>{dialogue_rows}</tbody></table>'

        audio_items_html = ""  # audio is now inline; kept for template compatibility

        sfx_html_epub = f'<p class="scene-sfx">🎵 {sfx}</p>' if sfx else ""
        epub_title_suffix = f' · {epub_scene_title}' if epub_scene_title else ""
        chapter_content = f"""<?xml version='1.0' encoding='utf-8'?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-TW">
<head>
  <title>第{i+1}幕{epub_title_suffix}</title>
  <link rel="stylesheet" type="text/css" href="../style/nav.css"/>
</head>
<body>
  <h1>第{i+1}幕{epub_title_suffix}</h1>
  <p class="scene-desc">{desc}</p>
  {sfx_html_epub}
  {img_html}
  {dialogue_html}
  {audio_items_html}
</body>
</html>"""

        chapter = epub.EpubHtml(title=f"第{i+1}幕{epub_title_suffix}", file_name=f"scenes/scene_{i}.xhtml", lang="zh-TW")
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


def _export_html(
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
        sfx = html.escape(scene.get("sfx_description", "").strip())
        scene_title = html.escape(scene.get("title", "").strip())
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
            # Normalise audio_fmt the same way all other exporters do (.lower(),
            # fallback to "mp3"), then strip any non-alphanumeric characters so a
            # crafted audio_format value cannot break out of the HTML src attribute
            # (e.g. `wav" onload="alert(1)` would otherwise inject JS into the
            # exported HTML file).
            audio_fmt = re.sub(r"[^a-z0-9]", "", (line.get("audio_format") or "mp3").lower()) or "mp3"
            if audio_b64:
                mime = "audio/mpeg" if audio_fmt == "mp3" else f"audio/{audio_fmt}"
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
        sfx_html = f'<p class="scene-sfx">🎵 {sfx}</p>' if sfx else ""
        title_suffix = f' <span class="scene-title-tag">· {scene_title}</span>' if scene_title else ""
        scene_htmls.append(f"""
  <section class="scene-card" id="scene-{i}">
    <h2 class="scene-title">第{i+1}幕{title_suffix}</h2>
    <p class="scene-desc">{desc}</p>
    {sfx_html}
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
            name        = html.escape(str(c.get("name", "")))
            emoji       = html.escape(str(c.get("emoji", "🎭")))
            personality = html.escape(str(c.get("personality", "")))
            color       = _safe_css_color(c.get("color", ""), fallback="#667eea")
            portrait_url = c.get("portrait_url", "") or ""
            line_count  = char_line_counts.get(c.get("name", ""), 0)
            line_badge  = (
                f'<div class="char-intro-lines" style="color:{color}">{line_count} 句</div>'
                if line_count > 0 else ""
            )
            # Show portrait if it's a safe data URI; otherwise fall back to emoji.
            # _safe_data_uri is checked via startswith("data:image/") to allow only
            # image data URIs — prevents arbitrary data: URLs from leaking.
            if portrait_url.startswith("data:image/"):
                safe_src = html.escape(portrait_url, quote=True)
                avatar_html = f'<img class="char-intro-portrait" src="{safe_src}" alt="{name}"/>'
            else:
                avatar_html = f'<div class="char-intro-emoji">{emoji}</div>'
            char_cards += f"""
      <div class="char-intro-card" style="border-top-color:{color}">
        {avatar_html}
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
            toc_title = html.escape(scene.get("title", "").strip())
            has_audio = any(line.get("audio_base64") for line in scene.get("lines", []))
            audio_badge = ' <span class="toc-audio-badge">🔊</span>' if has_audio else ""
            title_tag = (
                f' <span class="toc-scene-title">· {toc_title}</span>' if toc_title else ""
            )
            toc_items += f"""
      <li class="toc-item">
        <a href="#scene-{i}" class="toc-link">
          <span class="toc-num">第 {i+1} 幕{title_tag}</span>
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
    .scene-title-tag {{ font-size: 0.85rem; font-weight: 600; color: #7c5fcf; background: #f3eeff; border-radius: 6px; padding: 1px 8px; margin-left: 4px; vertical-align: middle; }}
    .scene-desc {{ color: #888; font-style: italic; margin-bottom: 8px; }}
    .scene-sfx {{ display: inline-flex; align-items: center; gap: 5px; font-size: 0.78rem; color: #7c6f9f; font-style: italic; background: #f8f5ff; border: 1px solid #e8e0ff; border-radius: 20px; padding: 3px 12px; margin-bottom: 16px; }}
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
    .char-intro-portrait {{ width: 64px; height: 64px; border-radius: 50%; object-fit: cover; display: block; margin: 0 auto 6px; border: 2px solid #e0e0e0; }}
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
    .toc-scene-title {{ font-size: 0.8rem; font-weight: 600; color: #7c5fcf; background: #f3eeff; border-radius: 4px; padding: 1px 6px; margin-left: 4px; }}
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
    // Stop any ongoing Play-All sequence, clear highlights, then play the
    // clicked line in isolation.  This prevents audio overlap when the user
    // clicks a specific line's "▶ 播放" button while auto-play is active.
    function playLine(sceneIdx, lineIdx) {{
      document.querySelectorAll('audio').forEach(function(a) {{ a.pause(); a.currentTime = 0; }});
      document.querySelectorAll('.dialogue-line.playing').forEach(function(el) {{ el.classList.remove('playing'); }});
      if (_cursor >= 0) {{
        _paused = true;
        var playBtn = document.getElementById('btn-play-all');
        if (playBtn) playBtn.textContent = '▶ 繼續';
      }}
      var lineEl = document.getElementById('line-' + sceneIdx + '-' + lineIdx);
      if (lineEl) {{ lineEl.classList.add('playing'); lineEl.scrollIntoView({{ behavior: 'smooth', block: 'center' }}); }}
      var audio = document.getElementById('audio-' + sceneIdx + '-' + lineIdx);
      if (audio) {{
        audio.currentTime = 0;
        audio.playbackRate = _speed;
        audio.onended = function() {{ if (lineEl) lineEl.classList.remove('playing'); }};
        audio.play().catch(function() {{ if (lineEl) lineEl.classList.remove('playing'); }});
      }}
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

    # M3U playlist entries: list of (filepath_in_zip, scene_label, char_name, text, duration_secs)
    # Built alongside the audio files so the playlist order matches the ZIP structure exactly.
    playlist_entries: list[tuple[str, str, str, str, int]] = []

    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, scene in enumerate(scenes):
            folder = f"幕{i+1:02d}"
            lines = scene.get("lines", [])
            desc = scene.get("description", "")
            title = scene.get("title", "").strip()
            scene_header = f"【第{i+1}幕】"
            if title:
                scene_header += f"《{title}》"
            scene_header += desc
            readme_lines.append(scene_header)
            scene_label = f"第{i+1}幕" + (f"《{title}》" if title else "")

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
                        # Estimate duration at _CHARS_PER_SEC Chinese chars/second (same as SRT export)
                        dur = max(1, math.ceil(len(text) / _CHARS_PER_SEC))
                        playlist_entries.append((filename, scene_label, char_name, text, dur))
                    except Exception as e:
                        logger.warning("MP3 ZIP audio decode failed: %s", e)
                else:
                    readme_lines.append("    （此行無音檔）")

            readme_lines.append("")

        readme_lines.append("=" * 40)
        if not has_any_audio:
            readme_lines.append("注意：此作品尚未生成任何語音，請先在創作工坊中生成配音後再匯出。")
        zf.writestr("README.txt", "\n".join(readme_lines).encode("utf-8"))

        # ── M3U playlist ─────────────────────────────────────────────────
        # An M3U file lets media players (VLC, Windows Media Player, etc.) open
        # the entire story as a single playlist in the correct scene/line order.
        # Each #EXTINF entry carries the estimated duration and a human-readable
        # title (「第N幕 · 角色名：台詞」) so the player's Now Playing shows
        # meaningful labels instead of raw filenames.
        if playlist_entries:
            m3u_lines = ["#EXTM3U", f"# 《{project_name}》有聲書完整播放清單", ""]
            for filepath, scene_label, char_name, text, dur in playlist_entries:
                # Truncate long lines so the title stays readable in player UIs
                short_text = text[:40] + "…" if len(text) > 40 else text
                title_tag = f"{scene_label} · {char_name}：{short_text}"
                m3u_lines.append(f"#EXTINF:{dur},{title_tag}")
                m3u_lines.append(filepath)
            m3u_lines.append("")
            safe_proj = re.sub(r'[\\/:*?"<>|]', "_", project_name)
            zf.writestr(f"{safe_proj}.m3u", "\n".join(m3u_lines).encode("utf-8"))

    return buf.getvalue()


# Reading-speed heuristic shared by txt / srt / md exporters (4 Chinese chars ≈ 1 second)
_CHARS_PER_SEC: int = 4


def _export_txt(project_name: str, scenes: list, characters: list | None = None) -> bytes:
    """Export the full script as a plain UTF-8 text file.

    Format:
        《書名》完整劇本
        ========
        ◆ 角色介紹（若有角色資料）
        ────────
        角色名（個性）外形描述
        ...
        ========
        【第1幕】場景描述（風格）
        ────────
        角色名：台詞
        ...
        ========
        共 N 幕 · M 句台詞 · 預估閱讀時長 X:XX
    """
    if characters is None:
        characters = []

    lines_out: list[str] = [
        f"《{project_name}》完整劇本",
        "=" * 40,
        "",
    ]

    # Character introduction section — mirrors PDF/EPUB/HTML/MD exports
    eligible_chars = [
        c for c in characters
        if c.get("name") and (c.get("personality") or c.get("visual_description"))
    ]
    if eligible_chars:
        lines_out.append("◆ 角色介紹")
        lines_out.append("─" * 30)
        for c in eligible_chars:
            emoji       = (c.get("emoji") or "").strip()
            name        = c.get("name", "").strip()
            personality = (c.get("personality") or "").strip()
            visual      = (c.get("visual_description") or "").strip()
            label = f"{emoji} {name}" if emoji else name
            detail_parts = []
            if personality:
                detail_parts.append(f"個性：{personality}")
            if visual:
                detail_parts.append(f"外形：{visual}")
            lines_out.append(label)
            if detail_parts:
                lines_out.append("  " + "　".join(detail_parts))
        lines_out.append("")
        lines_out.append("=" * 40)
        lines_out.append("")

    total_line_count = 0
    total_char_count = 0
    for i, scene in enumerate(scenes, 1):
        desc = scene.get("description", "").strip()
        style = scene.get("style", "").strip()
        title = scene.get("title", "").strip()
        header = f"【第{i}幕】"
        if title:
            header += f"《{title}》"
        header += desc
        if style:
            header += f"（{style}）"
        lines_out.append(header)
        lines_out.append("─" * 30)
        sfx = scene.get("sfx_description", "").strip()
        if sfx:
            lines_out.append(f"🎵 音效建議：{sfx}")
        for line in scene.get("lines", []):
            char_name = line.get("character_name", "").strip() or "旁白"
            text = line.get("text", "").strip()
            if text:
                lines_out.append(f"{char_name}：{text}")
                total_line_count += 1
                total_char_count += len(text)
        lines_out.append("")

    # Footer with reading time estimate
    est_secs = max(0, total_char_count // _CHARS_PER_SEC)
    est_min  = est_secs // 60
    est_sec  = est_secs % 60
    time_str = f"　預估閱讀時長 約 {est_min}:{est_sec:02d}" if est_secs >= 10 else ""
    lines_out += ["=" * 40, f"共 {len(scenes)} 幕　{total_line_count} 句台詞{time_str}", ""]
    return "\n".join(lines_out).encode("utf-8")


def _parse_audio_duration(audio_b64: str, fmt: str) -> float | None:
    """Extract actual playback duration (seconds) from a base64-encoded audio blob.

    Supports WAV (exact, via RIFF header) and MPEG1 Layer III MP3 (CBR estimate
    via frame header + file size).  Returns None on any parse failure so callers
    can fall back to the character-count heuristic.

    WAV layout (all little-endian):
        Bytes  0– 3  "RIFF"
        Bytes  4– 7  ChunkSize
        Bytes  8–11  "WAVE"
        then sub-chunks: "fmt " → ByteRate at chunk-data+8; "data" → chunk-data-size
        Duration = data-chunk-size / ByteRate

    MP3 layout:
        Optional ID3v2 tag (3 bytes "ID3" + 7 header bytes + syncsafe size)
        MPEG frame sync (0xFF 0xE? / 0xFF 0xF?)
        4-byte frame header → MPEG version, layer, bitrate index, sample-rate index
        Duration ≈ (audio_bytes × 8) / (bitrate_kbps × 1000)   [accurate for CBR]
    """
    try:
        data = base64.b64decode(audio_b64)
    except Exception:
        return None

    fmt = fmt.lower()

    if fmt == "wav":
        if len(data) < 44 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
            return None
        byte_rate: int | None = None
        offset = 12
        while offset + 8 <= len(data):
            chunk_id   = data[offset : offset + 4]
            chunk_size = struct.unpack_from("<I", data, offset + 4)[0]
            if chunk_id == b"fmt ":
                # chunk data layout: AudioFormat(2) NumChannels(2) SampleRate(4) ByteRate(4)…
                if offset + 20 <= len(data):
                    byte_rate = struct.unpack_from("<I", data, offset + 16)[0]
            elif chunk_id == b"data":
                if byte_rate and byte_rate > 0:
                    return chunk_size / byte_rate
                return None
            offset += 8 + chunk_size
            if chunk_size & 1:     # RIFF chunks are padded to even byte boundaries
                offset += 1
        return None

    elif fmt == "mp3":
        # Skip ID3v2 tag when present (3-byte magic + 7-byte header with syncsafe size)
        pos = 0
        if len(data) >= 10 and data[:3] == b"ID3":
            sz = (
                (data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14 |
                (data[8] & 0x7F) << 7  | (data[9] & 0x7F)
            )
            pos = 10 + sz
        # Walk forward until we find a valid MPEG sync word (max 4 kB search)
        limit = min(pos + 4096, len(data) - 4)
        while pos < limit:
            if data[pos] == 0xFF and (data[pos + 1] & 0xE0) == 0xE0:
                break
            pos += 1
        else:
            return None
        if pos >= len(data) - 4:
            return None
        # Parse the 4-byte MPEG frame header (big-endian)
        b0, b1, b2 = data[pos], data[pos + 1], data[pos + 2]
        mpeg_ver   = (b1 >> 3) & 0x3   # 0b11=MPEG1  0b10=MPEG2  0b00=MPEG2.5
        layer      = (b1 >> 1) & 0x3   # 0b01=LayerIII  0b10=LayerII  0b11=LayerI
        br_idx     = (b2 >> 4) & 0xF
        # Only handle MPEG1 LayerIII (0b11 / 0b01) — what all TTS engines here emit
        if mpeg_ver != 0b11 or layer != 0b01:
            return None
        BITRATES_MPEG1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
        if br_idx == 0 or br_idx == 15:
            return None
        bitrate_kbps = BITRATES_MPEG1_L3[br_idx]
        if bitrate_kbps == 0:
            return None
        # CBR duration estimate: (bytes after sync) × 8 / bitrate_bps
        return ((len(data) - pos) * 8) / (bitrate_kbps * 1000)

    return None


def _export_srt(project_name: str, scenes: list) -> bytes:
    """Export the full script as an SRT subtitle file.

    When a dialogue line has ``audio_base64``, the actual playback duration is
    extracted from the WAV/MP3 header via ``_parse_audio_duration``.  Lines
    without audio fall back to the 4-chars-per-second heuristic.

    Format per entry:
        1
        00:00:01,000 --> 00:00:05,000
        [角色名] 台詞文字

    Each scene is preceded by a 2-second title card entry so viewers can
    orient themselves within the story (e.g. "第2幕 · 神奇地圖").
    """
    GAP_SECS       = 0.5     # pause between consecutive lines
    MIN_SECS       = 1.5     # minimum display duration per line
    TITLE_SECS     = 2.0     # duration of the scene title card
    TITLE_GAP_SECS = 0.8     # pause between title card and first dialogue line

    def _fmt(total_secs: float) -> str:
        """Convert float seconds → SRT timestamp HH:MM:SS,mmm."""
        total_ms  = int(round(total_secs * 1000))
        ms        = total_ms % 1000
        total_s   = total_ms // 1000
        h         = total_s // 3600
        m         = (total_s % 3600) // 60
        s         = total_s % 60
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    entries: list[str] = []
    seq      = 1
    clock    = 1.0          # running position in seconds; start at 1 s not 0

    for scene_num, scene in enumerate(scenes, 1):
        scene_lines = [
            ln for ln in scene.get("lines", [])
            if (ln.get("text") or "").strip()
        ]
        if not scene_lines:
            continue

        # ── Scene title card ────────────────────────────────────────────
        scene_title = (scene.get("title") or "").strip()
        card_label  = f"第{scene_num}幕" + (f" · {scene_title}" if scene_title else "")
        card_end    = clock + TITLE_SECS
        entries.append(
            f"{seq}\n{_fmt(clock)} --> {_fmt(card_end)}\n【{card_label}】"
        )
        seq   += 1
        clock  = card_end + TITLE_GAP_SECS

        # ── Dialogue lines ───────────────────────────────────────────────
        for line in scene_lines:
            text      = line["text"].strip()
            char_name = (line.get("character_name") or "").strip() or "旁白"
            # Prefer actual audio duration for frame-accurate subtitle timing.
            # Falls back to the character-count heuristic when no audio exists.
            audio_b64 = line.get("audio_base64")
            audio_fmt = (line.get("audio_format") or "mp3").lower()
            actual    = _parse_audio_duration(audio_b64, audio_fmt) if audio_b64 else None
            duration  = max(MIN_SECS, actual if actual is not None else len(text) / _CHARS_PER_SEC)
            end_time  = clock + duration
            entries.append(
                f"{seq}\n{_fmt(clock)} --> {_fmt(end_time)}\n[{char_name}] {text}"
            )
            seq   += 1
            clock  = end_time + GAP_SECS

    return "\n\n".join(entries).encode("utf-8") if entries else b""


def _export_md(project_name: str, scenes: list, characters: list | None = None) -> bytes:
    """Export the full script as a GitHub-Flavored Markdown file.

    Format:
        # 《書名》
        ## 角色介紹（若有角色資料）
        ### 🐰 角色名
        **個性**：...
        **外形**：...
        ---
        ## 第1幕 · 標題（若有）
        > 風格 | 場景描述
        🎵 音效建議：...
        **角色名**：台詞
        ...
        ---
        *共 N 幕 · M 句台詞 · 預估閱讀時長 X 分 Y 秒*
    """
    if characters is None:
        characters = []

    lines_out: list[str] = [
        f"# 《{project_name}》",
        "",
    ]

    # Character introduction section — mirrors PDF/EPUB/HTML exports
    eligible_chars = [
        c for c in characters
        if c.get("name") and (c.get("personality") or c.get("visual_description"))
    ]
    if eligible_chars:
        lines_out.append("## 角色介紹")
        lines_out.append("")
        for c in eligible_chars:
            emoji       = (c.get("emoji") or "").strip()
            name        = c.get("name", "").strip()
            personality = (c.get("personality") or "").strip()
            visual      = (c.get("visual_description") or "").strip()

            heading = f"### {emoji} {name}" if emoji else f"### {name}"
            lines_out.append(heading)
            lines_out.append("")
            if personality:
                lines_out.append(f"**個性**：{personality}")
            if visual:
                lines_out.append(f"**外形**：{visual}")
            lines_out.append("")

        lines_out.append("---")
        lines_out.append("")

    total_line_count = 0
    total_char_count = 0
    for i, scene in enumerate(scenes, 1):
        title  = scene.get("title", "").strip()
        desc   = scene.get("description", "").strip()
        style  = scene.get("style", "").strip()
        sfx    = scene.get("sfx_description", "").strip()
        script_lines = scene.get("lines", [])

        # Section heading — include title when present
        heading = f"## 第{i}幕"
        if title:
            heading += f" · {title}"
        lines_out.append(heading)
        lines_out.append("")

        # Scene meta as blockquote
        meta_parts = []
        if style:
            meta_parts.append(style)
        if desc:
            meta_parts.append(desc)
        if meta_parts:
            lines_out.append(f"> {' | '.join(meta_parts)}")
            lines_out.append("")

        # Sound effects hint
        if sfx:
            lines_out.append(f"🎵 *{sfx}*")
            lines_out.append("")

        # Dialogue lines
        for line in script_lines:
            char_name = line.get("character_name", "").strip() or "旁白"
            text      = line.get("text", "").strip()
            if text:
                lines_out.append(f"**{char_name}**：{text}")
                total_line_count += 1
                total_char_count += len(text)

        lines_out.append("")
        lines_out.append("---")
        lines_out.append("")

    # Footer with reading time estimate
    est_secs = max(0, total_char_count // _CHARS_PER_SEC)
    est_min  = est_secs // 60
    est_sec  = est_secs % 60
    time_str = f"約 {est_min}:{est_sec:02d}" if est_secs >= 10 else ""

    footer_parts = [f"{len(scenes)} 幕", f"{total_line_count} 句台詞"]
    if time_str:
        footer_parts.append(f"預估閱讀時長 {time_str}")
    lines_out.append(f"*共 {' · '.join(footer_parts)}*")
    lines_out.append("")
    lines_out.append("*由「繪本有聲書創作工坊」匯出*")
    lines_out.append("")

    return "\n".join(lines_out).encode("utf-8")


def _export_images_zip(project_name: str, scenes: list) -> bytes:
    """Pack every scene illustration into a ZIP archive.

    Each image is stored as ``第NN幕_標題.jpg`` (or ``.png`` / ``.webp``,
    depending on the data URI MIME type).  Scenes with no image are skipped.
    A README.txt is always included to describe the contents.
    """
    buf = io.BytesIO()
    has_any_image = False
    readme_lines: list[str] = [
        f"《{project_name}》場景插圖",
        "=" * 40,
        "",
    ]
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, scene in enumerate(scenes, 1):
            image = scene.get("image", "") or ""
            title = (scene.get("title") or "").strip()
            desc  = (scene.get("description") or "").strip()[:30]

            label = f"第{i:02d}幕"
            if title:
                safe_title = re.sub(r'[\\/:*?"<>|]', "_", title)
                label += f"_{safe_title}"

            readme_lines.append(f"{label}：{desc}")

            if not image or image == "error":
                readme_lines.append("  （無插圖）")
                readme_lines.append("")
                continue

            try:
                if image.startswith("data:"):
                    header, b64 = image.split(",", 1)
                    mime = header.split(";")[0].split(":")[-1]
                    ext  = mime.split("/")[-1] if "/" in mime else "jpg"
                    image_bytes = base64.b64decode(b64)
                else:
                    image_bytes = base64.b64decode(image)
                    ext = "jpg"
                filename = f"{label}.{ext}"
                zf.writestr(filename, image_bytes)
                readme_lines.append(f"  → {filename}")
                has_any_image = True
            except Exception as e:
                logger.warning("Images ZIP decode failed scene %d: %s", i, e)
                readme_lines.append("  （插圖解碼失敗）")

            readme_lines.append("")

        readme_lines += [
            "=" * 40,
            f"共 {len(scenes)} 幕" + ("" if has_any_image else "，尚未生成任何插圖"),
        ]
        if not has_any_image:
            readme_lines.append("請先在創作工坊中生成插圖後再匯出。")
        zf.writestr("README.txt", "\n".join(readme_lines).encode("utf-8"))

    return buf.getvalue()


def _export_json_backup(project_name: str, scenes: list, characters: list) -> bytes:
    """Export a portable JSON backup of the story structure.

    The backup includes: project name, characters, and all scenes with their
    scripts and dialogue lines.  Media blobs (audio_base64, image) are stripped
    to keep the file small and shareable.  The file can be used as a text
    archive or re-imported into another instance in the future.

    Format:
        {
          "version": 1,
          "name": "書名",
          "exported_at": "ISO-8601 timestamp",
          "characters": [{id, name, personality, visual_description, voice_id, color, emoji}, ...],
          "scenes": [{idx, title, description, style, line_length, notes,
                      scene_prompt, sfx_description, lines: [{character_name,
                      character_id, voice_id, text, emotion}, ...]}, ...]
        }
    """
    from datetime import datetime, timezone
    data = {
        "version": 1,
        "name": project_name,
        "exported_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "characters": [
            {
                "id":                  c.get("id", ""),
                "name":                c.get("name", ""),
                "personality":         c.get("personality", ""),
                "visual_description":  c.get("visual_description", "") or "",
                "voice_id":            c.get("voice_id", ""),
                "color":               c.get("color", ""),
                "emoji":               c.get("emoji", "🎭"),
            }
            for c in characters
        ],
        "scenes": [
            {
                "idx":             s.get("idx", i),
                "title":           s.get("title", "") or "",
                "description":     s.get("description", ""),
                "style":           s.get("style", ""),
                "line_length":     s.get("line_length", "standard") or "standard",
                "image_style":     s.get("image_style", "") or "",
                "mood":            s.get("mood", "") or "",
                "age_group":       s.get("age_group", "child") or "child",
                "notes":           s.get("notes", "") or "",
                "is_locked":       bool(s.get("is_locked", False)),
                "scene_prompt":    s.get("scene_prompt", "") or "",
                "sfx_description": s.get("sfx_description", "") or "",
                "lines": [
                    {
                        "character_name": ln.get("character_name", ""),
                        "character_id":   ln.get("character_id", ""),
                        "voice_id":       ln.get("voice_id", ""),
                        "text":           ln.get("text", ""),
                        "emotion":        ln.get("emotion", "neutral"),
                    }
                    for ln in s.get("lines", [])
                    if ln.get("text", "").strip()
                ],
            }
            for i, s in enumerate(scenes, 1)
        ],
    }
    return json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
