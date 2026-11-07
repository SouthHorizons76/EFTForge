"""Check that /proxy-asset only ever fetches https URLs on its allowed hosts."""

import os
from types import SimpleNamespace

import pytest
from fastapi import HTTPException


@pytest.fixture
def proxy(monkeypatch):
    # Import lazily so collection does not need the app config.
    os.environ.setdefault("IP_HASH_SECRET", "proxy-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "proxy-test-admin")
    from routers import proxy

    fetched, redirects = [], []

    def fake_get(url, **kwargs):
        fetched.append(url)
        if redirects:
            location = redirects.pop(0)
            return SimpleNamespace(status_code=302, headers={"Location": location}, close=lambda: None)
        return SimpleNamespace(
            status_code=200,
            headers={"content-type": "image/png"},
            raise_for_status=lambda: None,
            iter_content=lambda chunk_size: iter([b"png"]),
            close=lambda: None,
        )

    monkeypatch.setattr(proxy.http_session, "get", fake_get)
    return SimpleNamespace(proxy_asset=proxy.proxy_asset, fetched=fetched, redirects=redirects)


BYPASSES = [
    # urllib.parse sees a gitee.com subdomain here; urllib3 connects to the first host.
    "https://127.0.0.1\\.gitee.com/",
    "https://evil.com\\.gitee.com/x.png",
    "https://evil.com\\@assets.tarkov.dev/x.png",
    "https://user@assets.tarkov.dev/x.png",
    "https://assets.tarkov.dev:8443/x.png",
    "http://assets.tarkov.dev/x.png",
    "https://evil.com#.gitee.com",
    "https://evil.com%2f.gitee.com/x.png",
    "https://localhost\t.gitee.com/",
    "https://evil.com .gitee.com/",
    "https://[::1].gitee.com/",
    "https://gitee.com.evil.com/",
    "https://notgitee.com/",
    "//assets.tarkov.dev/x.png",
    "",
]


@pytest.mark.parametrize("url", BYPASSES)
def test_disallowed_urls_are_rejected_before_any_request(proxy, url):
    with pytest.raises(HTTPException) as error:
        proxy.proxy_asset(url, None)
    assert error.value.status_code == 400
    assert proxy.fetched == []


@pytest.mark.parametrize(
    "url",
    [
        "https://assets.tarkov.dev/5c0e2f26d174af02a9625114-icon.webp",
        "https://ASSETS.tarkov.dev/x.png?v=2",
        "https://foruda.gitee.com/avatar/1.png",
        "https://gitee.com:443/morph1ne/eftforge-assets/raw/master/x.webp",
    ],
)
def test_allowed_urls_are_fetched(proxy, url):
    response = proxy.proxy_asset(url, None)
    assert response.status_code == 200
    assert len(proxy.fetched) == 1


@pytest.mark.parametrize("location", ["https://127.0.0.1\\.gitee.com/", "https://evil.com/x.png", "/relative.png"])
def test_redirects_off_the_allowlist_are_not_followed(proxy, location):
    proxy.redirects.append(location)
    with pytest.raises(HTTPException) as error:
        proxy.proxy_asset("https://gitee.com/a.png", None)
    assert error.value.status_code == 502
    assert proxy.fetched == ["https://gitee.com/a.png"]


def test_allowed_redirect_is_followed(proxy):
    proxy.redirects.append("https://foruda.gitee.com/b.png")
    assert proxy.proxy_asset("https://gitee.com/a.png", None).status_code == 200
    assert proxy.fetched == ["https://gitee.com/a.png", "https://foruda.gitee.com/b.png"]


def test_atlas_from_live_forwards_only_the_pages_reads(monkeypatch):
    os.environ.setdefault("IP_HASH_SECRET", "proxy-test-secret")
    os.environ.setdefault("ADMIN_API_KEY", "proxy-test-admin")
    from services import community_proxy

    monkeypatch.setattr(community_proxy, "ATLAS_FROM_LIVE", True)
    for path in (
        "/atlas/api/index",
        "/atlas/api/sets/c0ffee2",
        "/atlas/api/sets/c0ffee2/values/3",
        "/atlas/api/arena/index",
        "/atlas/api/arena/sets/abc",
        "/atlas/api/matching",
    ):
        assert community_proxy.atlas_from_live(path), path
    # the lookup goes through the local tunnel; key admin and the feed stay local too
    for path in (
        "/atlas/api/lookup",
        "/atlas/api/lookup/search",
        "/atlas/api/entry",
        "/atlas/api/v1/eft/changes",
        "/admin/atlas/keys",
        "/atlas/api/indexes",
    ):
        assert not community_proxy.atlas_from_live(path), path
    monkeypatch.setattr(community_proxy, "ATLAS_FROM_LIVE", False)
    assert not community_proxy.atlas_from_live("/atlas/api/index")
