from pathlib import Path
import tempfile
import zipfile

import fitz
from PIL import Image

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
    # The bundled H2Orestart must contain the LibreOffice TextFrame patch.
    extension = Path(__file__).parents[1] / "H2Orestart-0.7.13.oxt"
    with zipfile.ZipFile(extension) as outer:
        jar_bytes = outer.read("H2Orestart.jar")
    with tempfile.NamedTemporaryFile(suffix=".jar") as jar_file:
        jar_file.write(jar_bytes)
        jar_file.flush()
        with zipfile.ZipFile(jar_file.name) as jar:
            conv_table = jar.read("soffice/ConvTable.class")
    assert b"SurroundContour" not in conv_table
    assert b"BackTransparent" in conv_table

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
        # Question 1 occupies only the top of a much taller detected clip.
        # The renderer must discard that blank tail before the browser scales
        # the preview, otherwise the actual text becomes unreadably small.
        first_preview = Image.open(assets / processed[1]["preview"])
        assert first_preview.height < 180, first_preview.size
        print("smoke test passed: 5 two-column questions")


if __name__ == "__main__":
    main()
