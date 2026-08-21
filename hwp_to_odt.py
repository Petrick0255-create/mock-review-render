"""Convert binary HWP to an ODT package without pyhwp's outdated RNG check."""

from contextlib import closing
from pathlib import Path
import sys

from hwp5.hwp5odt import ODTTransform, open_odtpkg
from hwp5.xmlmodel import Hwp5File


def main(source: Path, destination: Path) -> None:
    # pyhwp's bundled ODF schema predates attributes emitted by its own XSLT
    # for some Hancom 2020 files. LibreOffice can still open the generated ODT,
    # so disable only that stale validation step—not the conversion itself.
    transform = ODTTransform(relaxng_compile=False)
    with closing(Hwp5File(str(source))) as hwp_file:
        with open_odtpkg(str(destination)) as odt_package:
            transform.transform_hwp5_to_package(hwp_file, odt_package)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: hwp_to_odt.py SOURCE.hwp OUTPUT.odt")
    main(Path(sys.argv[1]), Path(sys.argv[2]))
