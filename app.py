from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent

app = FastAPI(title="PDF NOTE COMPARE", version="1.0.0")


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "service": "pdf-note-compare"}


app.mount("/", StaticFiles(directory=ROOT / "static", html=True), name="static")
