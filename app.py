from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from document_engine import SUPPORTED, process_document
from gemini_service import analyze


ROOT = Path(__file__).resolve().parent
WORK_ROOT = Path(tempfile.gettempdir()) / "mock-review"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
MAX_BYTES = 40 * 1024 * 1024
JOBS: dict[str, dict] = {}
ANALYSIS_LIMIT = asyncio.Semaphore(2)

app = FastAPI(title="MOCK REVIEW", version="1.0.0")


def cleanup() -> None:
    threshold = time.time() - 2 * 60 * 60
    for folder in WORK_ROOT.iterdir():
        try:
            if folder.is_dir() and folder.stat().st_mtime < threshold:
                shutil.rmtree(folder, ignore_errors=True)
                JOBS.pop(folder.name, None)
        except OSError:
            pass


async def save_upload(upload: UploadFile, folder: Path, name: str) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in SUPPORTED:
        raise HTTPException(400, "PDF, HWP, HWPX 파일만 올릴 수 있습니다.")
    target = folder / f"{name}{suffix}"
    size = 0
    with target.open("wb") as output:
        while chunk := await upload.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_BYTES:
                output.close(); target.unlink(missing_ok=True)
                raise HTTPException(413, "파일 하나의 최대 크기는 40MB입니다.")
            output.write(chunk)
    return target


def job_or_404(job_id: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{32}", job_id):
        raise HTTPException(404, "작업이 존재하지 않습니다.")
    job = JOBS.get(job_id)
    if not job:
        path = WORK_ROOT / job_id / "job.json"
        if path.exists():
            job = json.loads(path.read_text(encoding="utf-8")); JOBS[job_id] = job
    if not job:
        raise HTTPException(404, "작업이 만료되었거나 존재하지 않습니다.")
    return job


def store(job: dict) -> None:
    folder = WORK_ROOT / job["id"]
    (folder / "job.json").write_text(json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8")
    JOBS[job["id"]] = job


@app.get("/api/health")
def health():
    return {"ok": True, "service": "mock-review"}


@app.post("/api/upload")
async def upload(
    problem: UploadFile = File(...),
    solution: UploadFile | None = File(None),
    subject: str = Form("통합과학"),
    year: str = Form(""),
    season: str = Form(""),
    round_name: str = Form(""),
):
    cleanup()
    job_id, folder = uuid.uuid4().hex, WORK_ROOT / uuid.uuid4().hex
    # Keep URL-safe random IDs and directory IDs identical.
    folder = WORK_ROOT / job_id
    assets = folder / "assets"
    assets.mkdir(parents=True)
    try:
        problem_path = await save_upload(problem, folder, "problem")
        solution_path = await save_upload(solution, folder, "solution") if solution and solution.filename else None
        problem_items, warnings = await asyncio.to_thread(process_document, problem_path, "problem", assets, "problem")
        solution_items, solution_warnings = ({}, [])
        if solution_path:
            solution_items, solution_warnings = await asyncio.to_thread(process_document, solution_path, "solution", assets, "solution")
        numbers = sorted(set(problem_items) | set(solution_items))
        items = []
        for number in numbers:
            p, s = problem_items.get(number, {}), solution_items.get(number, {})
            items.append({
                "number": number,
                "problem_text": p.get("text", ""),
                "solution_text": s.get("text", ""),
                "problem_preview": f"/api/jobs/{job_id}/assets/{p['preview']}" if p.get("preview") else None,
                "solution_preview": f"/api/jobs/{job_id}/assets/{s['preview']}" if s.get("preview") else None,
                "analysis": None,
            })
        job = {"id": job_id, "created": time.time(), "metadata": {"subject": subject, "year": year, "season": season, "round": round_name}, "items": items, "warnings": warnings + solution_warnings}
        store(job)
        return job
    except HTTPException:
        shutil.rmtree(folder, ignore_errors=True); raise
    except Exception as exc:
        shutil.rmtree(folder, ignore_errors=True)
        raise HTTPException(500, f"문서를 처리하지 못했습니다: {exc}") from exc


class AnalyzeRequest(BaseModel):
    api_key: str = ""
    number: int | None = None


@app.post("/api/jobs/{job_id}/analyze")
async def analyze_job(job_id: str, request: AnalyzeRequest):
    job = job_or_404(job_id)
    selected = [item for item in job["items"] if request.number is None or item["number"] == request.number]
    if request.number is not None and not selected:
        raise HTTPException(404, "해당 문항이 없습니다.")

    async def one(item):
        async with ANALYSIS_LIMIT:
            try:
                item["analysis"] = await analyze(item["number"], item["problem_text"], item["solution_text"], job["metadata"].get("subject", ""), request.api_key)
                item.pop("analysis_error", None)
            except Exception as exc:
                item["analysis_error"] = str(exc)

    # Small batches prevent free instances and API quotas from being flooded.
    for offset in range(0, len(selected), 2):
        await asyncio.gather(*(one(item) for item in selected[offset:offset + 2]))
        store(job)
    return job


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    return job_or_404(job_id)


@app.get("/api/jobs/{job_id}/assets/{name}")
def asset(job_id: str, name: str):
    job_or_404(job_id)
    if Path(name).name != name:
        raise HTTPException(400, "잘못된 파일명입니다.")
    path = WORK_ROOT / job_id / "assets" / name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path)


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
