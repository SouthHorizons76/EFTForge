# Run this right before `git add / commit / push` when preparing a release -
# replaces hand-editing the ?v=N numbers in index.html and hand-bumping
# APP_BUILD_DATE in modules/config.js (see CONTRIBUTING.md).
#
# Content-hashes each ?v= tagged asset from its actual bytes, so a file that
# didn't change keeps its old hash (stays cached) and a file that did change
# always gets a new URL (can never be served stale) - no more manually
# tracking which of the 20+ modules need a bump.

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path

from build_code_catalog import build_catalog

ROOT_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT_DIR / "frontend"
TARKOV_DB = ROOT_DIR / "backend" / "tarkov.db"
BUILD_CODES_JS = FRONTEND_DIR / "modules" / "build-codes.js"
INDEX_HTML = FRONTEND_DIR / "index.html"
# Every page whose ?v= tags get hashed. Asset refs are relative to the frontend root
# whether they're written "./css/x.css" or "/css/x.css".
PAGES = [
    INDEX_HTML,
    FRONTEND_DIR / "atlas" / "index.html",
    FRONTEND_DIR / "atlas" / "arena" / "index.html",
    FRONTEND_DIR / "atlas" / "matching" / "index.html",
    FRONTEND_DIR / "atlas" / "lookup" / "index.html",
]
CONFIG_JS = FRONTEND_DIR / "modules" / "config.js"

HASH_LEN = 10

ASSET_TAG_RE = re.compile(r'((?:src|href)=")([^"?]+)\?v=[^"&]+(")')


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


def hash_assets(page):
    html = page.read_text(encoding="utf-8")

    def replace(match):
        prefix, ref, suffix = match.group(1), match.group(2), match.group(3)
        asset_path = FRONTEND_DIR / ref.lstrip("./")
        digest = hashlib.sha256(asset_path.read_bytes()).hexdigest()[:HASH_LEN]
        print(f"  {ref} -> ?v={digest}")
        return f"{prefix}{ref}?v={digest}{suffix}"

    new_html, count = ASSET_TAG_RE.subn(replace, html)
    if count == 0:
        raise RuntimeError(f"No ?v= tagged assets found in {page.relative_to(FRONTEND_DIR)}")
    page.write_text(new_html, encoding="utf-8")
    print(f"Hashed {count} asset reference(s) in {page.relative_to(FRONTEND_DIR)}")


def check_build_code_catalog():
    # Warn (never block) when the newest share code dictionary no longer covers
    # every gun build the local database allows, so a new one gets cut in time.
    files = {
        int(m.group(1)): path
        for path in (FRONTEND_DIR / "data").glob("build-code-catalog-v*.js")
        if (m := re.fullmatch(r"build-code-catalog-v(\d+)\.js", path.name))
    }
    if not files:
        print("WARNING: no build code dictionary found in frontend/data")
        return
    latest = max(files)
    problems = []

    encoder = re.search(
        r"_encodeDictionaryBuildCode\(payload\) \{\s*const version = (\d+);", BUILD_CODES_JS.read_text("utf-8")
    )
    if not encoder or int(encoder.group(1)) != latest:
        problems.append(f"the encoder in modules/build-codes.js does not use v{latest}")
    index_html = INDEX_HTML.read_text(encoding="utf-8")
    for version in sorted(files):
        if f'src="data/build-code-catalog-v{version}.js"' not in index_html:
            problems.append(f"index.html has no script tag for build-code-catalog-v{version}.js")

    if not TARKOV_DB.exists():
        print("WARNING: backend/tarkov.db is missing, so the share code dictionary coverage was not checked")
    else:
        text = files[latest].read_text(encoding="utf-8")
        frozen = json.loads(text.split(f"EFTForge.buildCodeCatalogs[{latest}] = ", 1)[1].rstrip().rstrip(";"))
        live = build_catalog(TARKOV_DB)
        frozen_items = set(frozen["items"])
        frozen_slots = {slot for rows in frozen["slots"].values() for slot, _ in rows}
        # Only items a gun build can hold matter: guns, slot parents and slot candidates.
        buildable = {live["items"][int(parent)] for parent in live["slots"]}
        for rows in live["slots"].values():
            buildable.update(live["items"][index] for _, candidates in rows for index in candidates)
        missing_items = sorted(buildable - frozen_items)
        missing_slots = sorted({slot for rows in live["slots"].values() for slot, _ in rows} - frozen_slots)
        if missing_items:
            problems.append(f"{len(missing_items)} buildable item(s) missing, e.g. {', '.join(missing_items[:5])}")
        if missing_slots:
            problems.append(f"{len(missing_slots)} slot(s) missing, e.g. {', '.join(missing_slots[:5])}")

    if problems:
        print(f"\nWARNING: share code dictionary v{latest} is out of date. Builds using these export as 2. codes:")
        for problem in problems:
            print(f"  - {problem}")
        print(f"  Cut v{latest + 1} with: python scripts/build_code_catalog.py --version {latest + 1}")
        print("  then follow scripts/BUILD_CODES.md.\n")
    else:
        print(f"Share code dictionary v{latest} covers every buildable item and slot in backend/tarkov.db")


if __name__ == "__main__":
    check_build_code_catalog()
    # Stamp first: config.js's own content-hash below needs to reflect the
    # build date that just got written into it.
    stamp_build_date()
    for page in PAGES:
        hash_assets(page)
