# Third-party components

This project bundles `H2Orestart 0.7.13` to render HWP 5/HWPX files in LibreOffice.

- Project: https://github.com/ebandal/H2Orestart
- Release: https://github.com/ebandal/H2Orestart/releases/tag/v0.7.13
- License: GNU GPL v3
- Bundled file SHA-256: `1bc52dd1c34493b8eaf9152c9ce92bf6baa60171d2541b5ae0caca0e4a5ec787`

### LibreOffice 7.4 compatibility patch

In `soffice.ConvTable`, the `SurroundContour` property write for a
LibreOffice `TextFrame` is replaced with the supported boolean
`BackTransparent` property. `SurroundContour` belongs to graphic objects and
caused Debian Bookworm's LibreOffice to abort HWP table conversion with
`UnknownPropertyException`.

## pyhwp

This project installs `pyhwp 0.1b15` to convert binary HWP files to ODT in an
isolated Python process before LibreOffice produces the PDF.

- Project: https://github.com/mete0r/pyhwp
- License: GNU Affero General Public License v3 or later
