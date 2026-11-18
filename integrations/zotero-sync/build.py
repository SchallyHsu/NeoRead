"""Build the file-installable Zotero companion using the Python standard library."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent
version = json.loads((root / "manifest.json").read_text(encoding="utf-8"))["version"]
output = root / ("neoread-zotero-sync-" + version + ".xpi")
with ZipFile(output, "w", ZIP_DEFLATED) as archive:
    for name in ["manifest.json", "bootstrap.js", "bridge.js", "model.js", "read.html"]:
        archive.write(root / name, name)
print(output)
