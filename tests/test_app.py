from fastapi.testclient import TestClient

from app import app


client = TestClient(app)


def test_health() -> None:
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True, "service": "pdf-note-compare"}


def test_viewer_assets() -> None:
    page = client.get("/")
    assert page.status_code == 200
    assert "PDF NOTE COMPARE" in page.text
    assert "문제 PDF" in page.text
    assert "해설 PDF" in page.text
    assert client.get("/app.js").status_code == 200
    assert client.get("/vendor/pdf.worker.mjs").status_code == 200
