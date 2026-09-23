# Run this right before `git add / commit / push` when preparing a release -
# replaces hand-editing the ?v=N numbers in index.html and hand-bumping
# APP_BUILD_DATE in modules/config.js (see CONTRIBUTING.md).
#
# Content-hash each local JavaScript and CSS asset from its actual bytes, so a file that
# didn't change keeps its old hash (stays cached) and a file that did change
# always gets a new URL (can never be served stale) - no more manually
# tracking which of the 20+ modules need a bump.

import hashlib
import re
from datetime import datetime, timezone
from pathlib import Path

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
INDEX_HTML = FRONTEND_DIR / "index.html"
CONFIG_JS = FRONTEND_DIR / "modules" / "config.js"

HASH_LEN = 10

ASSET_TAG_RE = re.compile(r'((?:src|href)=")([^"?#]+\.(?:js|css))(?:\?v=[^"&]+)?(")')


def stamp_build_date():
    text = CONFIG_JS.read_text(encoding="utf-8")
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"
    new_text, count = re.subn(
        r'(APP_BUILD_DATE:\s*")[^"]*(")',
        rf"\g<1>{stamp}\g<2>",
        text,
        count=1,
    )
    if count != 1:
        raise RuntimeError("Could not find APP_BUILD_DATE in modules/config.js")
    CONFIG_JS.write_text(new_text, encoding="utf-8")
    print(f"Stamped APP_BUILD_DATE -> {stamp}")


def hash_assets():
    html = INDEX_HTML.read_text(encoding="utf-8")

    def replace(match):
        prefix, ref, suffix = match.group(1), match.group(2), match.group(3)
        # Include new local modules without requiring a hand-written version first.
        if ref.startswith(("https:", "http:", "//", "data:")):
            return match.group(0)
        asset_path = FRONTEND_DIR / ref.lstrip("./")
        digest = hashlib.sha256(asset_path.read_bytes()).hexdigest()[:HASH_LEN]
        print(f"  {ref} -> ?v={digest}")
        return f"{prefix}{ref}?v={digest}{suffix}"

    new_html, count = ASSET_TAG_RE.subn(replace, html)
    if count == 0:
        raise RuntimeError("No JavaScript or CSS asset references found in index.html")
    INDEX_HTML.write_text(new_html, encoding="utf-8")
    print(f"Hashed {count} asset reference(s) in index.html")


if __name__ == "__main__":
    # Stamp first: config.js's own content-hash below needs to reflect the
    # build date that just got written into it.
    stamp_build_date()
    hash_assets()
