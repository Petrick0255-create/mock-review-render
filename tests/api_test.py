from pathlib import Path

import fitz
from fastapi.testclient import TestClient

import app as application


def fake_convert(source: Path, output_dir: Path):
    target = output_dir / f"{source.stem}.pdf"
    document = fitz.open()
    page = document.new_page()
    page.insert_text((72, 72), "01. converted question")
    document.save(target)
    document.close()
    return target, ""


def main():
    original = application.convert_to_pdf
    application.convert_to_pdf = fake_convert
    try:
        client = TestClient(application.app)
        home = client.get("/")
        assert home.status_code == 200
        assert 'id="converterView"' in home.text
        assert 'id="conversionDialog"' in home.text
        response = client.post(
            "/api/convert",
            files={"document": ("sample.hwp", b"fake hwp bytes", "application/octet-stream")},
        )
        assert response.status_code == 200, response.text
        converted = response.json()
        assert converted["page_count"] == 1
        assert converted["download_name"] == "sample.pdf"

        preview = client.get(converted["pdf_url"])
        assert preview.status_code == 200
        assert preview.content.startswith(b"%PDF")
        assert "attachment" not in preview.headers.get("content-disposition", "")

        download = client.get(converted["download_url"])
        assert download.status_code == 200
        assert "attachment" in download.headers.get("content-disposition", "")
        print("api test passed: convert -> preview/download")
    finally:
        application.convert_to_pdf = original


if __name__ == "__main__":
    main()
