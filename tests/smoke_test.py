from pathlib import Path
import tempfile

import fitz

from document_engine import detect_questions, process_document


def build_pdf(path: Path):
    doc = fitz.open()
    for page_index in range(2):
        page = doc.new_page(width=595, height=842)
        if page_index == 0:
            page.insert_text((40, 60), "01. first question", fontsize=13)
            page.insert_text((40, 430), "02. second question", fontsize=13)
            page.insert_text((320, 60), "03. third question", fontsize=13)
            page.insert_text((320, 430), "04. fourth question", fontsize=13)
        else:
            page.insert_text((40, 60), "05. fifth question", fontsize=13)
    doc.save(path)


def main():
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        pdf = root / "sample.pdf"
        assets = root / "assets"
        assets.mkdir()
        build_pdf(pdf)
        doc = fitz.open(pdf)
        questions, warnings = detect_questions(doc, "problem")
        doc.close()
        assert list(questions) == [1, 2, 3, 4, 5], (questions, warnings)
        processed, _ = process_document(pdf, "problem", assets, "problem")
        assert list(processed) == [1, 2, 3, 4, 5]
        assert all((assets / item["preview"]).exists() for item in processed.values())
        print("smoke test passed: 5 two-column questions")


if __name__ == "__main__":
    main()
