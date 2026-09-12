"""Mirror a desktop release to Gitee for users in China.

Steps:
  1. Create (or reuse) a release with the same tag on the Gitee mirror repo.
  2. Upload the NSIS installer (+ .sig) as release attachments - unless the
     installer is over Gitee's hard 100MB per-attachment limit, in which case
     the release keeps no attachment and the manifest's "url" (below) falls
     back to the GitHub release asset instead. This only affects the large
     binary download; latest.json itself still gets published to the Gitee
     assets repo, so the in-app update *check* stays fast for China-based
     users even when the actual download has to come from GitHub.
  3. Build the Gitee variant of latest.json - identical to the GitHub one but
     pointing at wherever step 2 actually put the installer - and commit it
     to the assets repo at desktop/latest.json (the raw URL the app's
     updater checks first).

Usage:
    python desktop/scripts/mirror_to_gitee.py --tag app-v0.1.0 [--notes "..."]
Env:
    GITEE_TOKEN          personal access token (required)
    GITEE_OWNER          default: morph1ne
    GITEE_RELEASES_REPO  repo that hosts the release attachments, default: eftforge-gitee-mirror
    GITEE_ASSETS_REPO    repo whose raw files serve latest.json, default: eftforge-assets
    GITHUB_MIRROR_OWNER  GitHub owner to fall back to when the exe is too big, default: SouthHorizons76
    GITHUB_MIRROR_REPO   GitHub repo to fall back to when the exe is too big, default: EFTForge
"""

import argparse
import base64
import glob
import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

UPLOAD_RETRIES = 4
UPLOAD_RETRY_BACKOFF_SECS = 20  # doubles each attempt: 20s, 40s, 80s

# Gitee's actual cap is 100MB; staying a little under it leaves room for
# filesystem/transfer overhead instead of finding out exactly at the edge.
GITEE_MAX_ATTACHMENT_BYTES = 95_000_000

API = "https://gitee.com/api/v5"

DESKTOP_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
BUNDLE_DIR  = os.path.join(DESKTOP_DIR, "src-tauri", "target", "release", "bundle", "nsis")

TOKEN = os.environ.get("GITEE_TOKEN", "")
OWNER = os.environ.get("GITEE_OWNER", "morph1ne")
RELEASES_REPO = os.environ.get("GITEE_RELEASES_REPO", "eftforge-gitee-mirror")
ASSETS_REPO   = os.environ.get("GITEE_ASSETS_REPO", "eftforge-assets")
GITHUB_OWNER  = os.environ.get("GITHUB_MIRROR_OWNER", "SouthHorizons76")
GITHUB_REPO   = os.environ.get("GITHUB_MIRROR_REPO", "EFTForge")


def _die(msg: str) -> None:
    sys.exit(f"mirror_to_gitee: {msg}")


def find_bundle(version: str) -> tuple[str, str]:
    # Match the exe to the requested version - this script usually runs on a
    # dev machine whose bundle dir accumulates exes from previous builds, and
    # a bare *-setup.exe glob picks the oldest one alphabetically (this once
    # published a "1.4.8" manifest that pointed at the 1.4.7 installer).
    exes = glob.glob(os.path.join(BUNDLE_DIR, f"*_{version}_*-setup.exe"))
    if not exes:
        _die(f"no NSIS setup exe for version {version} in {BUNDLE_DIR}")
    exe = exes[0]
    sig = exe + ".sig"
    if not os.path.exists(sig):
        _die(f"missing {sig}")
    return exe, sig


def ensure_release(tag: str, notes: str) -> int:
    """Create the release on the mirror repo, or return the existing one."""
    r = requests.get(
        f"{API}/repos/{OWNER}/{RELEASES_REPO}/releases/tags/{tag}",
        params={"access_token": TOKEN}, timeout=30,
    )
    if r.status_code == 200 and r.json():
        return r.json()["id"]
    r = requests.post(
        f"{API}/repos/{OWNER}/{RELEASES_REPO}/releases",
        json={
            "access_token": TOKEN,
            "tag_name": tag,
            "name": f"EFTForge Desktop {tag}",
            "body": notes or f"EFTForge desktop release {tag}",
            "target_commitish": "main",
        },
        timeout=30,
    )
    if r.status_code not in (200, 201):
        _die(f"release create failed ({r.status_code}): {r.text[:500]}")
    return r.json()["id"]


def upload_attachment(release_id: int, path: str) -> str:
    """Upload with retries - cross-border connections to Gitee from CI runners
    stall often enough that a single attempt isn't reliable."""
    last_err = None
    for attempt in range(1, UPLOAD_RETRIES + 1):
        try:
            with open(path, "rb") as f:
                r = requests.post(
                    f"{API}/repos/{OWNER}/{RELEASES_REPO}/releases/{release_id}/attach_files",
                    params={"access_token": TOKEN},
                    files={"file": (os.path.basename(path), f)},
                    timeout=600,
                )
            if r.status_code in (200, 201):
                data = r.json()
                return data.get("browser_download_url") or data.get("download_url") or ""
            last_err = f"{r.status_code}: {r.text[:500]}"
        except requests.exceptions.RequestException as exc:
            last_err = str(exc)

        if attempt < UPLOAD_RETRIES:
            wait = UPLOAD_RETRY_BACKOFF_SECS * (2 ** (attempt - 1))
            print(f"attachment upload attempt {attempt}/{UPLOAD_RETRIES} failed ({last_err}); retrying in {wait}s")
            time.sleep(wait)

    _die(f"attachment upload failed for {path} after {UPLOAD_RETRIES} attempts: {last_err}")
    return ""  # unreachable, _die exits


def upsert_assets_file(repo_path: str, content: bytes, message: str) -> None:
    """Create or update a file in the assets repo via the contents API."""
    url = f"{API}/repos/{OWNER}/{ASSETS_REPO}/contents/{repo_path}"
    b64 = base64.b64encode(content).decode()
    existing = requests.get(url, params={"access_token": TOKEN, "ref": "master"}, timeout=30)
    if existing.status_code == 200 and isinstance(existing.json(), dict) and existing.json().get("sha"):
        r = requests.put(url, json={
            "access_token": TOKEN, "content": b64, "message": message,
            "sha": existing.json()["sha"], "branch": "master",
        }, timeout=60)
    else:
        r = requests.post(url, json={
            "access_token": TOKEN, "content": b64, "message": message, "branch": "master",
        }, timeout=60)
    if r.status_code not in (200, 201):
        _die(f"assets repo update failed ({r.status_code}): {r.text[:500]}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", required=True)
    parser.add_argument("--notes", default="")
    args = parser.parse_args()

    if not TOKEN:
        _die("GITEE_TOKEN not set")

    version = args.tag.removeprefix("app-v").removeprefix("v")
    exe, sig = find_bundle(version)
    with open(sig, "r", encoding="utf-8") as f:
        signature = f.read().strip()

    exe_size = os.path.getsize(exe)
    if exe_size > GITEE_MAX_ATTACHMENT_BYTES:
        # Over Gitee's cap - skip the attachment upload entirely (it would
        # just fail) and point the manifest at the GitHub release asset
        # instead. That release must already exist under this same tag
        # (desktop-release.yml publishes it before this script ever runs).
        #
        # Critically, the signature must come from THAT SAME GitHub-built
        # exe, not the local one read above: this script runs against a
        # local `tauri build` output, which is a separate, independently-
        # signed build from whatever desktop-release.yml produced on a CI
        # runner. The two exes aren't byte-identical even at the same
        # version (different build machine/timestamps), so a signature
        # computed over the local exe will fail Tauri's Ed25519 verification
        # against the GitHub-hosted binary. Fetch CI's own .sig instead so
        # the signature actually matches the bytes the URL points at.
        github_url = f"https://github.com/{GITHUB_OWNER}/{GITHUB_REPO}/releases/download/{args.tag}/{os.path.basename(exe)}"
        sig_resp = requests.get(github_url + ".sig", timeout=30)
        if sig_resp.status_code != 200:
            _die(
                f"installer is over Gitee's attachment cap and the GitHub release's .sig "
                f"couldn't be fetched ({sig_resp.status_code}) from {github_url}.sig - "
                f"has desktop-release.yml published this tag yet?"
            )
        signature = sig_resp.text.strip()
        print(
            f"installer is {exe_size / 1_000_000:.1f}MB, over Gitee's ~100MB attachment cap - "
            f"falling back to the GitHub asset (and its matching signature) for: {github_url}"
        )
        notes = args.notes or (
            f"EFTForge 桌面版 {version}。安装包体积超过 Gitee 附件限制，"
            f"请改为从 GitHub 下载：{github_url}"
        )
        release_id = ensure_release(args.tag, notes)
        print(f"Gitee release id: {release_id}")
        exe_url = github_url
    else:
        release_id = ensure_release(args.tag, args.notes)
        print(f"Gitee release id: {release_id}")

        exe_url = upload_attachment(release_id, exe)
        upload_attachment(release_id, sig)
        if not exe_url:
            _die("Gitee did not return a download URL for the installer")
        print(f"Installer mirrored: {exe_url}")

    manifest = {
        "version": version,
        "notes": args.notes or f"EFTForge desktop {version}",
        "pub_date": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            "windows-x86_64": {"signature": signature, "url": exe_url},
        },
    }
    upsert_assets_file(
        "desktop/latest.json",
        json.dumps(manifest, indent=2).encode("utf-8"),
        f"desktop updater manifest {args.tag}",
    )
    print(f"Updater manifest published: https://gitee.com/{OWNER}/{ASSETS_REPO}/raw/master/desktop/latest.json")


if __name__ == "__main__":
    main()
