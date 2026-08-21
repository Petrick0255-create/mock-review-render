from __future__ import annotations

import json
import os
import re

import httpx


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


async def analyze(number: int, problem: str, solution: str, subject: str, api_key: str) -> dict:
    key = (api_key or os.getenv("GEMINI_API_KEY", "")).strip()
    if not key:
        raise ValueError("Gemini API 키가 없습니다. Render 환경변수 또는 화면의 API 키를 입력하세요.")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent"
    payload = {
        "contents": [{"parts": [{"text": prompt(number, problem, solution, subject)}]}],
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
