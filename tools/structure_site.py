#!/usr/bin/env python3
"""Generate a structured, non-production preview from the current monolithic index.html.

The source index.html is read-only. The script externalises CSS, JavaScript and embedded
images, then adds the official Steam store widget to /preview/.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import shutil
import unicodedata
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "index.html"
PREVIEW_DIR = ROOT / "preview"
ASSETS_DIR = ROOT / "assets"
CSS_FILE = ASSETS_DIR / "css" / "site.css"
JS_FILE = ASSETS_DIR / "js" / "site.js"
IMAGES_DIR = ASSETS_DIR / "images"
MANIFEST_FILE = IMAGES_DIR / "manifest.json"
REPORT_FILE = ROOT / "STRUCTURED_SITE_PREVIEW.md"

APP_ID = "4997100"
WIDGET_WIDTH = 646
WIDGET_HEIGHT = 190

EN_DESCRIPTION = (
    "Build an aircraft company from the pioneering era of flight. Design and test "
    "aircraft, acquire engines, negotiate contracts, manage production and cash flow, "
    "and grow your reputation with every successful delivery."
)
PT_DESCRIPTION = (
    "Constrói uma empresa aeronáutica desde os primeiros anos da aviação. Desenha e "
    "testa aviões, compra motores, negoceia encomendas, gere a produção e o fluxo de "
    "caixa e aumenta a reputação da empresa com cada entrega bem-sucedida."
)

MIME_EXTENSIONS = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
}

STYLE_RE = re.compile(r"<style(?:\s[^>]*)?>(.*?)</style>", re.IGNORECASE | re.DOTALL)
SCRIPT_RE = re.compile(r"<script(?:\s[^>]*)?>(.*?)</script>", re.IGNORECASE | re.DOTALL)
IMG_TAG_RE = re.compile(r"<img\b[^>]*>", re.IGNORECASE | re.DOTALL)
SRC_DATA_RE = re.compile(
    r"\bsrc=(?P<quote>[\"'])(?P<data>data:image/[^\"']+)(?P=quote)",
    re.IGNORECASE | re.DOTALL,
)
DATA_URL_RE = re.compile(
    r"data:(?P<mime>image/[A-Za-z0-9.+-]+);base64,(?P<payload>[A-Za-z0-9+/=\r\n]+)",
    re.IGNORECASE,
)
CSS_DATA_RE = re.compile(
    r"data:(?P<mime>image/[A-Za-z0-9.+-]+);base64,(?P<payload>[A-Za-z0-9+/=\r\n]+)",
    re.IGNORECASE,
)
ALT_RE = re.compile(r"\balt=(?P<quote>[\"'])(?P<alt>.*?)(?P=quote)", re.IGNORECASE | re.DOTALL)


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def slugify(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = value.lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:64] or "site-image"


def decode_data_url(data_url: str) -> tuple[str, bytes]:
    match = DATA_URL_RE.fullmatch(data_url.strip())
    if not match:
        fail("Unsupported or malformed embedded image data URL.")
    mime = match.group("mime").lower()
    payload = re.sub(r"\s+", "", match.group("payload"))
    try:
        binary = base64.b64decode(payload, validate=True)
    except Exception as exc:  # pragma: no cover - surfaced in workflow logs
        fail(f"Could not decode embedded {mime} image: {exc}")
    if not binary:
        fail(f"Decoded {mime} image is empty.")
    return mime, binary


def build_widget_url(description: str, language: str, content: str) -> str:
    return (
        f"https://store.steampowered.com/widget/{APP_ID}/"
        f"?t={quote(description, safe='')}"
        f"&l={language}"
        "&utm_source=official_website"
        "&utm_medium=website"
        "&utm_campaign=steam_page_launch"
        f"&utm_content={content}"
    )


def main() -> None:
    if not SOURCE.exists():
        fail("Root index.html was not found.")

    source_text = SOURCE.read_text(encoding="utf-8")
    source_sha256 = hashlib.sha256(source_text.encode("utf-8")).hexdigest()

    style_matches = list(STYLE_RE.finditer(source_text))
    script_matches = list(SCRIPT_RE.finditer(source_text))
    if len(style_matches) != 1:
        fail(f"Expected exactly one inline <style>; found {len(style_matches)}.")
    if len(script_matches) != 1:
        fail(f"Expected exactly one inline <script>; found {len(script_matches)}.")

    css_text = style_matches[0].group(1).strip() + "\n"
    js_text = script_matches[0].group(1).strip() + "\n"

    # Rebuild generated directories from the source every time.
    for directory in (PREVIEW_DIR, ASSETS_DIR):
        if directory.exists():
            shutil.rmtree(directory)
    CSS_FILE.parent.mkdir(parents=True, exist_ok=True)
    JS_FILE.parent.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    manifest: list[dict[str, object]] = []
    hash_to_filename: dict[str, str] = {}
    used_names: set[str] = set()
    sequence = 0

    def store_image(data_url: str, preferred_name: str, source: str) -> str:
        nonlocal sequence
        mime, binary = decode_data_url(data_url)
        digest = hashlib.sha256(binary).hexdigest()
        if digest in hash_to_filename:
            filename = hash_to_filename[digest]
            manifest.append(
                {
                    "file": filename,
                    "mime": mime,
                    "sha256": digest,
                    "bytes": len(binary),
                    "source": source,
                    "duplicate": True,
                }
            )
            return filename

        sequence += 1
        extension = MIME_EXTENSIONS.get(mime)
        if not extension:
            fail(f"No file extension mapping exists for {mime}.")
        base_name = slugify(preferred_name) if preferred_name else f"site-image-{sequence:02d}"
        candidate = base_name
        suffix = 2
        while f"{candidate}{extension}" in used_names:
            candidate = f"{base_name}-{suffix}"
            suffix += 1
        filename = f"{candidate}{extension}"
        used_names.add(filename)
        hash_to_filename[digest] = filename
        (IMAGES_DIR / filename).write_bytes(binary)
        manifest.append(
            {
                "file": filename,
                "mime": mime,
                "sha256": digest,
                "bytes": len(binary),
                "source": source,
                "duplicate": False,
            }
        )
        return filename

    # Extract embedded CSS images. The first one is the hero background in the current site.
    css_image_index = 0

    def replace_css_data(match: re.Match[str]) -> str:
        nonlocal css_image_index
        css_image_index += 1
        data_url = match.group(0)
        preferred = "hero-background" if css_image_index == 1 else f"css-image-{css_image_index:02d}"
        filename = store_image(data_url, preferred, f"css:{css_image_index}")
        return f"/assets/images/{filename}"

    css_text = CSS_DATA_RE.sub(replace_css_data, css_text)

    # Remove the inline style and script before extracting HTML images.
    html_text = STYLE_RE.sub('<link href="/assets/css/site.css" rel="stylesheet"/>', source_text, count=1)
    html_text = SCRIPT_RE.sub('<script src="/assets/js/site.js"></script>', html_text, count=1)

    html_image_index = 0

    def replace_img_tag(match: re.Match[str]) -> str:
        nonlocal html_image_index
        tag = match.group(0)
        src_match = SRC_DATA_RE.search(tag)
        if not src_match:
            return tag
        html_image_index += 1
        alt_match = ALT_RE.search(tag)
        alt_text = alt_match.group("alt").strip() if alt_match else ""
        preferred = alt_text or f"site-image-{html_image_index:02d}"
        filename = store_image(src_match.group("data"), preferred, f"html-img:{html_image_index}")
        replacement = f'src="/assets/images/{filename}"'
        return tag[: src_match.start()] + replacement + tag[src_match.end() :]

    html_text = IMG_TAG_RE.sub(replace_img_tag, html_text)

    # Catch any remaining embedded image outside an <img> tag.
    fallback_index = 0

    def replace_fallback_data(match: re.Match[str]) -> str:
        nonlocal fallback_index
        fallback_index += 1
        filename = store_image(match.group(0), f"embedded-image-{fallback_index:02d}", f"html-fallback:{fallback_index}")
        return f"/assets/images/{filename}"

    html_text = DATA_URL_RE.sub(replace_fallback_data, html_text)

    en_widget_url = build_widget_url(EN_DESCRIPTION, "english", "steam_widget_en")
    pt_widget_url = build_widget_url(PT_DESCRIPTION, "portuguese", "steam_widget_pt")

    steam_section = f'''<section class="section steam-section" id="steam">
<div class="wrap steam-grid">
<div class="steam-copy">
<div class="kicker" id="steam-kicker">Official Steam page</div>
<h2 id="steam-title">Wishlist Aircraft Tycoon on Steam.</h2>
<p class="copy" id="steam-copy">Follow the development and add the game to your wishlist to receive future Steam updates.</p>
</div>
<div class="steam-widget-column">
<div class="steam-widget-viewport" id="steam-widget-viewport">
<iframe allowfullscreen="" class="steam-widget-frame" frameborder="0" height="{WIDGET_HEIGHT}" id="steam-widget" loading="lazy" src="{en_widget_url.replace('&', '&amp;')}" title="Aircraft Tycoon on Steam" width="{WIDGET_WIDTH}"></iframe>
</div>
<noscript><a class="steam-fallback" href="https://store.steampowered.com/app/{APP_ID}/?utm_source=official_website&amp;utm_medium=website&amp;utm_campaign=steam_page_launch&amp;utm_content=steam_widget_fallback">View Aircraft Tycoon on Steam</a></noscript>
</div>
</div>
</section>
'''

    game_marker = '<section class="section" id="game">'
    if html_text.count(game_marker) != 1:
        fail("Could not identify the single game section marker after the hero.")
    html_text = html_text.replace(game_marker, steam_section + game_marker, 1)

    steam_css = r'''
/* Official Steam store widget section. The iframe itself is rendered by Steam. */
.steam-section{background:linear-gradient(180deg,rgba(28,36,43,.42),rgba(13,17,21,0))}
.steam-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,646px);gap:48px;align-items:center}
.steam-copy .copy{max-width:480px}
.steam-widget-column{min-width:0;display:flex;justify-content:flex-end}
.steam-widget-viewport{width:min(100%,646px);height:190px;overflow:hidden}
.steam-widget-frame{display:block;width:646px;height:190px;border:0;transform-origin:top left}
.steam-fallback{color:var(--gold2);text-decoration:underline;text-underline-offset:4px}
@media(max-width:900px){.steam-grid{grid-template-columns:1fr}.steam-widget-column{justify-content:flex-start}.steam-copy .copy{max-width:720px}}
'''.strip()
    css_text = css_text.rstrip() + "\n\n" + steam_css + "\n"

    steam_js = f'''

// Official Steam widget integration for the structured preview.
(() => {{
  const widgetSources = {{
    en: {json.dumps(en_widget_url)},
    pt: {json.dumps(pt_widget_url)}
  }};
  const copy = {{
    en: {{
      kicker: 'Official Steam page',
      title: 'Wishlist Aircraft Tycoon on Steam.',
      body: 'Follow the development and add the game to your wishlist to receive future Steam updates.',
      frameTitle: 'Aircraft Tycoon on Steam'
    }},
    pt: {{
      kicker: 'Página oficial na Steam',
      title: 'Adiciona Aircraft Tycoon à tua lista de desejos.',
      body: 'Acompanha o desenvolvimento e adiciona o jogo à tua lista de desejos para receber futuras novidades na Steam.',
      frameTitle: 'Aircraft Tycoon na Steam'
    }}
  }};

  const frame = document.getElementById('steam-widget');
  const viewport = document.getElementById('steam-widget-viewport');
  const kicker = document.getElementById('steam-kicker');
  const title = document.getElementById('steam-title');
  const body = document.getElementById('steam-copy');

  function setSteamLanguage(language) {{
    const lang = language === 'pt' ? 'pt' : 'en';
    if (kicker) kicker.textContent = copy[lang].kicker;
    if (title) title.textContent = copy[lang].title;
    if (body) body.textContent = copy[lang].body;
    if (frame) {{
      frame.title = copy[lang].frameTitle;
      if (frame.src !== widgetSources[lang]) frame.src = widgetSources[lang];
    }}
  }}

  function resizeSteamWidget() {{
    if (!frame || !viewport) return;
    const scale = Math.min(1, viewport.clientWidth / {WIDGET_WIDTH});
    frame.style.transform = `scale(${{scale}})`;
    viewport.style.height = `${{Math.ceil({WIDGET_HEIGHT} * scale)}}px`;
  }}

  document.getElementById('en')?.addEventListener('click', () => setSteamLanguage('en'));
  document.getElementById('pt')?.addEventListener('click', () => setSteamLanguage('pt'));

  const initialLanguage = document.getElementById('pt')?.classList.contains('active') ? 'pt' : 'en';
  setSteamLanguage(initialLanguage);
  resizeSteamWidget();

  if ('ResizeObserver' in window && viewport) {{
    new ResizeObserver(resizeSteamWidget).observe(viewport);
  }} else {{
    window.addEventListener('resize', resizeSteamWidget);
  }}
}})();
'''.rstrip() + "\n"
    js_text = js_text.rstrip() + steam_js

    if "data:image/" in html_text or "data:image/" in css_text or "data:image/" in js_text:
        fail("At least one embedded image remained after extraction.")
    if "store.steampowered.com/widget/4997100" not in html_text:
        fail("The official Aircraft Tycoon Steam widget was not inserted.")
    if not manifest:
        fail("No embedded images were extracted; refusing to generate a potentially incomplete copy.")

    CSS_FILE.write_text(css_text, encoding="utf-8")
    JS_FILE.write_text(js_text, encoding="utf-8")
    PREVIEW_DIR.joinpath("index.html").write_text(html_text, encoding="utf-8")
    MANIFEST_FILE.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    unique_images = sum(1 for item in manifest if not item["duplicate"])
    total_bytes = sum(int(item["bytes"]) for item in manifest if not item["duplicate"])
    report = f"""# Structured Website Preview

This branch contains a generated, structured copy of the current Aircraft Tycoon website.

## Safety boundary

- The production `index.html` remains unchanged.
- The structured copy is available at `/preview/`.
- CSS, JavaScript and embedded images were externalised into `/assets/`.
- The official Steam widget for App ID `{APP_ID}` is included only in the structured preview.
- No custom Steam logo or imitation Steam button was created.

## Generation baseline

- Source `index.html` SHA-256: `{source_sha256}`
- Unique extracted images: {unique_images}
- Extracted image bytes: {total_bytes}
- English UTM content: `steam_widget_en`
- Portuguese UTM content: `steam_widget_pt`

## Review gate

Do not replace the production root page until the `/preview/` version has been reviewed in EN and PT-PT at desktop, tablet and mobile widths, with runtime screenshots and explicit approval.
"""
    REPORT_FILE.write_text(report, encoding="utf-8")

    print(f"Generated structured preview from source SHA-256 {source_sha256}")
    print(f"Extracted {unique_images} unique images ({total_bytes} bytes)")
    print(f"Preview: {PREVIEW_DIR / 'index.html'}")


if __name__ == "__main__":
    main()
