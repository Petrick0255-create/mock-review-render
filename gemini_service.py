from __future__ import annotations

import json
import os
import re
import base64
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image


MODEL = "gemini-3.1-flash-lite"
LABELS = {1: "하", 2: "중하", 3: "중", 4: "중상", 5: "상", 6: "최상"}

SCHEMA = {
    "type": "object",
    "properties": {
        "difficulty_score": {"type": "integer", "minimum": 1, "maximum": 6},
        "difficulty_label": {"type": "string", "enum": list(LABELS.values())},
        "recommended_points": {"type": "number", "minimum": 0.5, "maximum": 10},
        "answer": {"type": "string"},
        "confidence": {"type": "integer", "minimum": 0, "maximum": 100},
        "summary": {"type": "string"},
        "strengths": {"type": "array", "items": {"type": "string"}},
        "errors": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["개념", "논리", "조건", "표현", "정답·해설", "형식"]},
                    "severity": {"type": "string", "enum": ["확인", "수정 권장", "치명"]},
                    "location": {"type": "string"},
                    "message": {"type": "string"},
                    "suggestion": {"type": "string"},
                },
                "required": ["category", "severity", "location", "message", "suggestion"],
            },
        },
    },
    "required": ["difficulty_score", "difficulty_label", "recommended_points", "answer", "confidence", "summary", "strengths", "errors"],
}


def prompt(number: int, problem: str, solution: str, subject: str) -> str:
    return f"""당신은 한국 고등학교 모의고사 출제 검수자입니다.
과목: {subject or '미지정'}, 문항: {number:02d}번

[문제]
{problem[:24000] or '(문제 본문 없음)'}

[해설]
{solution[:24000] or '(해설 파일 없음)'}

먼저 문제를 독립적으로 풀고, 그 뒤 해설과 정답을 대조하세요.
난이도는 하=1, 중하=2, 중=3, 중상=4, 상=5, 최상=6입니다.
recommended_points는 0.5점 단위로 제안하세요.
오류는 실제 근거가 있을 때만 기록하고, 위치·문제점·수정안을 구체적으로 쓰세요.
해설이 없으면 해설 오류를 지어내지 마세요. 출력은 지정된 JSON 형식만 사용하세요."""


def image_parts(images: list[tuple[str, Path]]) -> list[dict]:
    """Prepare readable, bounded image slices for Gemini inline input."""
    parts: list[dict] = []
    for label, path in images:
        if not path.is_file():
            continue
        with Image.open(path) as source:
            image = source.convert("RGB")
            if image.width > 1800:
                height = round(image.height * 1800 / image.width)
                image = image.resize((1800, height), Image.Resampling.LANCZOS)
            slice_height = 3600
            count = max(1, (image.height + slice_height - 1) // slice_height)
            for index in range(count):
                crop = image.crop((0, index * slice_height, image.width, min(image.height, (index + 1) * slice_height)))
                output = BytesIO()
                crop.save(output, "JPEG", quality=90, optimize=True)
                parts.append({"text": f"[{label} 이미지 {index + 1}/{count}]"})
                parts.append({
                    "inline_data": {
                        "mime_type": "image/jpeg",
                        "data": base64.b64encode(output.getvalue()).decode("ascii"),
                    }
                })
    return parts


async def analyze(
    number: int,
    problem: str,
    solution: str,
    subject: str,
    api_key: str,
    images: list[tuple[str, Path]] | None = None,
) -> dict:
    key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if not key:
        raise ValueError("Gemini API 키가 없습니다. Render 환경변수 또는 화면의 API 키를 입력하세요.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    parts = [{"text": prompt(number, problem, solution, subject)}]
    parts.extend(image_parts(images or []))
    parts.append({"text": "위 추출 텍스트와 이미지를 모두 근거로 검수하세요. 텍스트 추출이 깨졌거나 수식·표·그림 정보가 빠졌다면 이미지를 우선하고, 서로 다르면 그 차이를 오류 근거로 명시하세요."})
    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "temperature": 0.15,
            "responseMimeType": "application/json",
            "responseJsonSchema": SCHEMA,
        },
    }
    async with httpx.AsyncClient(timeout=120) as client:
        response = await client.post(url, params={"key": key}, json=payload)
    if response.status_code >= 400:
        try:
            message = response.json().get("error", {}).get("message", response.text)
        except Exception:
            message = response.text
        raise RuntimeError(f"Gemini 요청 실패 ({response.status_code}): {message[:500]}")
    data = response.json()
    try:
        raw = data["candidates"][0]["content"]["parts"][0]["text"]
        result = json.loads(re.sub(r"^```json\s*|\s*```$", "", raw.strip()))
    except Exception as exc:
        raise RuntimeError("Gemini 응답 JSON을 읽지 못했습니다.") from exc
    score = max(1, min(6, int(result.get("difficulty_score", 3))))
    result["difficulty_score"] = score
    result["difficulty_label"] = LABELS[score]
    result["recommended_points"] = round(float(result.get("recommended_points", 2)) * 2) / 2
    result["errors"] = result.get("errors") if isinstance(result.get("errors"), list) else []
    return result
