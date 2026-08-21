from __future__ import annotations

import html
import re
import shutil
import struct
import subprocess
import tempfile
import unicodedata
import uuid
import zipfile
import zlib
from dataclasses import dataclass
from pathlib import Path

import fitz
from PIL import Image, ImageDraw, ImageFont


QUESTION_RE = re.compile(r"^\s*(?:(0[1-9])|((?:1\d|2[0-5])))\s*(?:번|[.)])")
STRICT_RE = re.compile(r"^\s*(?:(0[1-9])|((?:1\d|2[0-5])))\s*번\s*답(?:\s|$|[-–—:①②③④⑤])")
SUPPORTED = {".pdf", ".hwp", ".hwpx"}


@dataclass(frozen=True)
class ClipSpec:
    page_index: int
    rect: fitz.Rect


def normalize(value: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", value)).strip()


def question_number(text: str, strict: bool = False) -> int | None:
    clean = re.sub(r"[\u200b-\u200d\ufeff\ufffc]", "", unicodedata.normalize("NFKC", text))
    clean = re.sub(r"(?<=\d)\s+(?=\d)", "", clean)
    match = (STRICT_RE if strict else QUESTION_RE).search(clean)
    if not match or match.start() > 6:
        return None
    return int(match.group(1) or match.group(2))


def page_lines(page: fitz.Page) -> list[tuple[str, fitz.Rect]]:
    result = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            if not spans:
                continue
            text = "".join(span.get("text", "") for span in spans)
            if not text.strip():
                continue
            rect = fitz.Rect(spans[0]["bbox"])
            for span in spans[1:]:
                rect |= fitz.Rect(span["bbox"])
            result.append((text, rect))
    return sorted(result, key=lambda item: (item[1].y0, item[1].x0))


def character_candidates(page: fitz.Page, strict: bool) -> list[tuple[int, fitz.Rect]]:
    found = []
    pattern = r"(?<!\d)(0[1-9]|1\d|2[0-5])번답" if strict else r"(?<!\d)(0[1-9]|1\d|2[0-5])(?:번|[.)])"
    for block in page.get_text("rawdict").get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            chars = []
            for span in line.get("spans", []):
                for char in span.get("chars", []):
                    value = unicodedata.normalize("NFKC", char.get("c", ""))
                    if value and not value.isspace():
                        chars.append((value, fitz.Rect(char["bbox"])))
            chars.sort(key=lambda item: item[1].x0)
            match = re.search(pattern, "".join(c for c, _ in chars))
            if not match:
                continue
            start, end = match.span(1)
            rect = fitz.Rect(chars[start][1])
            for _, char_rect in chars[start + 1:min(len(chars), end + 2)]:
                rect |= char_rect
            found.append((int(match.group(1)), rect))
    return found


def collect_candidates(document: fitz.Document, strict: bool) -> list[tuple[int, int, fitz.Rect]]:
    found, seen = [], set()

    def add(number: int, page_index: int, rect: fitz.Rect) -> None:
        key = number, page_index, round(rect.x0 / 3), round(rect.y0 / 3)
        if key not in seen:
            seen.add(key)
            found.append((number, page_index, fitz.Rect(rect)))

    for page_index, page in enumerate(document):
        for text, rect in page_lines(page):
            number = question_number(text, strict)
            if number:
                add(number, page_index, rect)
        for number, rect in character_candidates(page, strict):
            add(number, page_index, rect)
        for number in range(1, 26):
            digits = f"{number:02d}"
            variants = [f"{digits}번 답", f"{digits} 번 답"] if strict else [f"{digits}번", f"{digits} 번", f"{digits}.", f"{digits})"]
            for variant in variants:
                hits = page.search_for(variant)
                if hits:
                    for hit in hits:
                        add(number, page_index, hit)
                    break

    def order(item):
        number, page_index, rect = item
        page = document[page_index].rect
        column = 0 if rect.x0 < page.x0 + page.width * .5 else 1
        return page_index, column, rect.y0, rect.x0, number

    return sorted(found, key=order)


def detect_questions(document: fitz.Document, role: str) -> tuple[dict[int, list[ClipSpec]], list[str]]:
    candidates = collect_candidates(document, role == "solution")
    if not any(n == 1 for n, _, _ in candidates):
        candidates = collect_candidates(document, False)
    starts, warnings, expected = [], [], 1
    for number, page_index, rect in candidates:
        if number == expected:
            starts.append((number, page_index, rect))
            expected += 1
        elif starts and number == starts[-1][0]:
            continue
    if not starts:
        return {}, ["01번 제목을 찾지 못했습니다."]
    if expected <= 25:
        warnings.append(f"{expected:02d}번 이후 제목을 찾지 못했습니다.")
    two_column = any(rect.x0 >= document[p].rect.width * .5 for _, p, rect in starts)
    width = 2 if two_column else 1

    def col(page_index, rect):
        return int(two_column and rect.x0 >= document[page_index].rect.width * .5)

    def flow(page_index, rect):
        return page_index * width + col(page_index, rect)

    def column_rect(page_index, column):
        page = document[page_index].rect
        if not two_column:
            return fitz.Rect(page)
        mid = page.x0 + page.width * .5
        return fitz.Rect(page.x0, page.y0, mid + 3, page.y1) if column == 0 else fitz.Rect(mid - 3, page.y0, page.x1, page.y1)

    result = {}
    for index, (number, start_page, start_rect) in enumerate(starts):
        start_flow = flow(start_page, start_rect)
        if index + 1 < len(starts):
            _, end_page, end_rect = starts[index + 1]
            end_flow, end_y = flow(end_page, end_rect), end_rect.y0 - 5
        else:
            end_page = document.page_count - 1
            end_flow, end_y = (end_page + 1) * width - 1, document[end_page].rect.y1
        parts = []
        for cursor in range(start_flow, end_flow + 1):
            page_index, column = divmod(cursor, width)
            clip = column_rect(page_index, column)
            top = max(clip.y0, start_rect.y0 - 5) if cursor == start_flow else clip.y0
            bottom = min(clip.y1, end_y) if cursor == end_flow else clip.y1
            if bottom - top > 3:
                parts.append(ClipSpec(page_index, fitz.Rect(clip.x0, top, clip.x1, bottom)))
        result[number] = parts
    return result, warnings


def render_question(document: fitz.Document, clips: list[ClipSpec], destination: Path) -> str:
    images, texts = [], []
    matrix = fitz.Matrix(1.65, 1.65)
    for spec in clips:
        page = document[spec.page_index]
        pix = page.get_pixmap(matrix=matrix, clip=spec.rect, alpha=False)
        images.append(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
        texts.append(page.get_text("text", clip=spec.rect).strip())
    if images:
        width = max(image.width for image in images)
        height = sum(image.height for image in images)
        merged = Image.new("RGB", (width, height), "white")
        y = 0
        for image in images:
            merged.paste(image, (0, y))
            y += image.height
        merged.save(destination, "WEBP", quality=88, method=4)
    return "\n".join(filter(None, texts))


HWP_EXTENDED = set(range(1, 9)) | {11, 12} | set(range(14, 24))


def hwp_records(data: bytes):
    position = 0
    while position + 4 <= len(data):
        header = struct.unpack_from("<I", data, position)[0]
        tag, size, header_size = header & 0x3FF, (header >> 20) & 0xFFF, 4
        if size == 0xFFF:
            if position + 8 > len(data):
                break
            size, header_size = struct.unpack_from("<I", data, position + 4)[0], 8
        end = position + header_size + size
        if end > len(data):
            break
        yield tag, data[position + header_size:end]
        position = end


def decode_hwp_paragraph(payload: bytes) -> str:
    payload = payload[:len(payload) // 2 * 2]
    units = struct.unpack(f"<{len(payload)//2}H", payload)
    visible, position = [], 0
    while position < len(units):
        code = units[position]
        if code in HWP_EXTENDED and position + 8 <= len(units):
            position += 8
            continue
        if code in {9, 10, 13, 24, 30, 31}:
            visible.append("\n")
        elif code >= 32:
            visible.append(chr(code))
        position += 1
    return re.sub(r"[ \t]+", " ", "".join(visible)).strip()


def extract_hwp_text(path: Path) -> str:
    import olefile

    document = olefile.OleFileIO(str(path))
    try:
        header = document.openstream("FileHeader").read()
        flags = struct.unpack_from("<I", header, 36)[0] if len(header) >= 40 else 0
        if flags & 2:
            raise ValueError("암호화된 HWP입니다.")
        compressed = bool(flags & 1)
        names = ["/".join(p) for p in document.listdir() if len(p) == 2 and p[0] == "BodyText" and p[1].startswith("Section")]
        names.sort(key=lambda n: int(re.search(r"\d+$", n).group()))
        paragraphs = []
        for name in names:
            stream = document.openstream(name).read()
            if compressed:
                stream = zlib.decompress(stream, -15)
            paragraphs.extend(decode_hwp_paragraph(payload) for tag, payload in hwp_records(stream) if tag == 67)
        return "\n".join(filter(None, paragraphs))
    finally:
        document.close()


def extract_hwpx_text(path: Path) -> str:
    chunks = []
    with zipfile.ZipFile(path) as archive:
        for name in sorted(n for n in archive.namelist() if re.search(r"Contents/section\d+\.xml$", n, re.I)):
            raw = archive.read(name).decode("utf-8", errors="ignore")
            chunks.append("\n".join(normalize(html.unescape(re.sub(r"<[^>]+>", " ", line))) for line in re.split(r"</[^>]*p>", raw)))
    return "\n".join(chunks)


def split_text_questions(text: str, role: str) -> dict[int, str]:
    strict = role == "solution"
    starts = []
    for match in re.finditer(r"(?m)^\s*(0[1-9]|1\d|2[0-5])\s*(?:번\s*답|번|[.)])", text):
        if strict and "답" not in match.group(0):
            continue
        starts.append((int(match.group(1)), match.start()))
    if not starts and strict:
        return split_text_questions(text, "problem")
    ordered, expected = [], 1
    for number, position in starts:
        if number == expected:
            ordered.append((number, position)); expected += 1
    return {number: text[position:(ordered[index + 1][1] if index + 1 < len(ordered) else len(text))].strip() for index, (number, position) in enumerate(ordered)}


def text_preview(text: str, destination: Path) -> None:
    font_path = next((p for p in [Path("/usr/share/fonts/truetype/nanum/NanumGothic.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")] if p.exists()), None)
    font = ImageFont.truetype(str(font_path), 27) if font_path else ImageFont.load_default()
    small = ImageFont.truetype(str(font_path), 18) if font_path else ImageFont.load_default()
    width, margin, content_width = 1200, 64, 1072
    measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    lines: list[str] = []
    for paragraph in text.splitlines() or [text]:
        paragraph = paragraph.rstrip()
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for character in paragraph:
            candidate = current + character
            if current and measure.textlength(candidate, font=font) > content_width:
                lines.append(current.rstrip())
                current = character.lstrip()
            else:
                current = candidate
        lines.append(current)
    line_height, header_height = 45, 78
    height = max(360, header_height + 54 + line_height * len(lines))
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, header_height), fill="#17233d")
    draw.text((margin, 25), "HWP 문항 이미지 · 텍스트 재조판", fill="white", font=small)
    draw.line((margin, header_height + 25, width - margin, header_height + 25), fill="#dce3ee", width=2)
    draw.multiline_text((margin, header_height + 46), "\n".join(lines), fill="#17233d", font=font, spacing=line_height - 27)
    image.save(destination, "WEBP", quality=88)


def repair_hwp_html_headings(html_path: Path) -> int:
    """Restore heading digits that pyhwp occasionally drops from HWP fields."""
    from lxml import etree

    parser = etree.XMLParser(recover=True)
    tree = etree.parse(str(html_path), parser)
    expected = 1
    repaired = 0
    for element in tree.xpath('//*[local-name()="p"]'):
        text = normalize("".join(element.itertext()))
        number = question_number(text, strict=False)
        if number == expected:
            expected += 1
            continue
        # In some Hancom 2020 files a field control consumes only the heading
        # digits, leaving "답 ③-..." visible. Its position in the 01..25
        # sequence is still unambiguous, so put the lost digits back before
        # Chromium captures the page.
        child_classes = " ".join(str(child.get("class", "")) for child in element.iter())
        if expected <= 25 and re.match(r"^답(?:\s|$)", text) and "charshape-7" in child_classes:
            element.text = f"{expected:02d}번 " + (element.text or "")
            expected += 1
            repaired += 1
    tree.write(str(html_path), encoding="utf-8", xml_declaration=True, doctype="<!DOCTYPE html>")
    return repaired


def convert_to_pdf(source: Path, output_dir: Path) -> tuple[Path | None, str]:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    if not soffice:
        return None, "LibreOffice 실행 파일이 설치되어 있지 않습니다."
    target = output_dir / f"{source.stem}.pdf"
    intermediate = output_dir / f"{source.stem}.odt"
    diagnostics: list[str] = []

    def run(arguments: list[str], label: str) -> subprocess.CompletedProcess:
        profile = Path("/tmp") / f"lo-{uuid.uuid4().hex}"
        try:
            completed = subprocess.run(
                [
                    soffice,
                    f"-env:UserInstallation=file://{profile}",
                    "--headless",
                    "--norestore",
                    "--nofirststartwizard",
                    *arguments,
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            message = normalize(" ".join(filter(None, (completed.stdout, completed.stderr))))
            diagnostics.append(f"{label}: 종료코드 {completed.returncode}" + (f", {message[:500]}" if message else ""))
            return completed
        finally:
            shutil.rmtree(profile, ignore_errors=True)

    target.unlink(missing_ok=True)
    run([
        "--infilter=Hwp2002_File", "--convert-to", "pdf:writer_pdf_Export",
        "--outdir", str(output_dir), str(source),
    ], "HWP→PDF 직접 변환")
    if target.exists() and target.stat().st_size > 0:
        return target, ""

    # Some HWP 2020 documents only complete import after an ODT save. Retry
    # through ODT before declaring the renderer unusable.
    intermediate.unlink(missing_ok=True)
    run([
        "--infilter=Hwp2002_File", "--convert-to", "odt:writer8",
        "--outdir", str(output_dir), str(source),
    ], "HWP→ODT 중간 변환")
    if intermediate.exists() and intermediate.stat().st_size > 0:
        run([
            "--convert-to", "pdf:writer_pdf_Export", "--outdir", str(output_dir),
            str(intermediate),
        ], "ODT→PDF 변환")
    intermediate.unlink(missing_ok=True)
    if target.exists() and target.stat().st_size > 0:
        return target, ""

    # Final layout fallback for HWP 5 / Hancom 2020: pyhwp expands the
    # document into HTML with its tables and embedded BinData images, then a
    # headless browser prints that rendered page to PDF. This is materially
    # different from drawing extracted plain text onto a blank bitmap.
    hwp5html = shutil.which("hwp5html")
    chromium = shutil.which("chromium") or shutil.which("chromium-browser")
    if source.suffix.lower() == ".hwp" and hwp5html and chromium:
        html_dir = Path(tempfile.mkdtemp(prefix="hwp-html-", dir=output_dir))
        try:
            html_result = subprocess.run(
                [hwp5html, "--output", str(html_dir), str(source)],
                capture_output=True,
                text=True,
                timeout=180,
            )
            html_message = normalize(" ".join(filter(None, (html_result.stdout, html_result.stderr))))
            diagnostics.append(
                f"HWP→HTML 개체 추출: 종료코드 {html_result.returncode}"
                + (f", {html_message[:500]}" if html_message else "")
            )
            html_path = html_dir / "index.xhtml"
            if html_result.returncode == 0 and html_path.exists():
                repaired = repair_hwp_html_headings(html_path)
                diagnostics.append(f"HTML 문항 번호 복구: {repaired}개")
                target.unlink(missing_ok=True)
                chrome_result = subprocess.run(
                    [
                        chromium,
                        "--headless",
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        "--disable-gpu",
                        "--no-pdf-header-footer",
                        f"--print-to-pdf={target}",
                        html_path.as_uri(),
                    ],
                    capture_output=True,
                    text=True,
                    timeout=180,
                )
                chrome_message = normalize(" ".join(filter(None, (chrome_result.stdout, chrome_result.stderr))))
                diagnostics.append(
                    f"HTML 화면 캡처→PDF: 종료코드 {chrome_result.returncode}"
                    + (f", {chrome_message[:500]}" if chrome_message else "")
                )
                if target.exists() and target.stat().st_size > 0:
                    return target, ""
        finally:
            shutil.rmtree(html_dir, ignore_errors=True)
    return None, " | ".join(diagnostics) or "변환기가 결과 파일을 만들지 않았습니다."


def process_document(source: Path, role: str, assets: Path, prefix: str) -> tuple[dict[int, dict], list[str]]:
    suffix = source.suffix.lower()
    if suffix not in SUPPORTED:
        raise ValueError("PDF, HWP, HWPX 파일만 지원합니다.")
    conversion_error = ""
    if suffix == ".pdf":
        pdf = source
    else:
        pdf, conversion_error = convert_to_pdf(source, source.parent)
    if pdf:
        document = fitz.open(pdf)
        try:
            questions, warnings = detect_questions(document, role)
            result = {}
            for number, clips in questions.items():
                name = f"{prefix}-{number:02d}.webp"
                result[number] = {"text": render_question(document, clips, assets / name), "preview": name, "preview_mode": "original"}
            return result, warnings
        finally:
            document.close()
    text = extract_hwp_text(source) if suffix == ".hwp" else extract_hwpx_text(source)
    split = split_text_questions(text, role)
    result = {}
    for number, content in split.items():
        name = f"{prefix}-{number:02d}.webp"
        text_preview(content, assets / name)
        result[number] = {"text": content, "preview": name, "preview_mode": "reconstructed"}
    warning = [
        "HWP 2020 원본 렌더링에 실패했습니다. 최신 H2Orestart로 직접 변환과 ODT 중간 변환을 모두 시도했습니다. "
        f"서버 진단: {conversion_error}"
    ]
    if not result:
        warning.append("문항 번호를 찾지 못했습니다. 제목을 '01번' 형식으로 확인하세요.")
    return result, warning
