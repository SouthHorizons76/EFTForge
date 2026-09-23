"""Check release hashing against isolated fixture assets."""

import hashlib
import importlib.util
from pathlib import Path


def test_hash_assets_includes_new_modules_and_preserves_remote_urls(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[2] / "scripts" / "release_prep.py"
    spec = importlib.util.spec_from_file_location("release_prep", script)
    release_prep = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(release_prep)

    (tmp_path / "modules").mkdir()
    assets = {
        "modules/layout.js": b"const layout = {};\n",
        "modules/existing.js": b"const existing = {};\n",
        "styles.css": b"body { color: white; }\n",
    }
    for name, content in assets.items():
        (tmp_path / name).write_bytes(content)
    html = tmp_path / "index.html"
    html.write_text(
        '<script src="modules/layout.js"></script>\n'
        '<script src="modules/existing.js?v=old"></script>\n'
        '<link href="styles.css">\n'
        '<script src="https://cdn.example.test/remote.js?v=keep"></script>\n'
        '<script src="//cdn.example.test/remote.js"></script>\n'
        '<img src="image.png">\n',
        encoding="utf-8",
    )
    monkeypatch.setattr(release_prep, "FRONTEND_DIR", tmp_path)
    monkeypatch.setattr(release_prep, "INDEX_HTML", html)

    release_prep.hash_assets()
    result = html.read_text(encoding="utf-8")
    for name, content in assets.items():
        digest = hashlib.sha256(content).hexdigest()[: release_prep.HASH_LEN]
        assert f'"{name}?v={digest}"' in result
    assert 'src="https://cdn.example.test/remote.js?v=keep"' in result
    assert 'src="//cdn.example.test/remote.js"' in result
    assert '<img src="image.png">' in result

    release_prep.hash_assets()
    assert html.read_text(encoding="utf-8") == result
