"""
End-to-end tests for the security fixes: OTP flow, dev-only leaks,
token refresh/revocation, single-use reset links, avatars and /api/query.
"""

import pytest
from httpx import AsyncClient

from app.api.routes import auth as auth_routes
from app.config import settings
from app.core.avatar import gravatar_url
from app.core.rate_limit import limiter


@pytest.fixture(autouse=True)
def _isolate(monkeypatch):
    # Never send real email from tests; reset rate-limit counters per test.
    # These tests cover the email flows, so email is on unless a test says otherwise.
    monkeypatch.setattr(settings, "email_enabled", True)
    monkeypatch.setattr(auth_routes, "send_otp_email", lambda *a, **k: False)
    monkeypatch.setattr(auth_routes, "send_password_reset_email", lambda *a, **k: False)
    if hasattr(limiter, "reset"):
        try:
            limiter.reset()
        except Exception:
            pass
    yield


async def _register(client: AsyncClient, email="new@test.com"):
    return await client.post(
        "/auth/register",
        json={
            "name": "New User",
            "email": email,
            "password": "Password1",
        },
    )


async def test_dev_otp_only_in_development(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "is_development", False)
    r = await _register(client, "prod@test.com")
    assert r.status_code == 201
    assert "dev_otp" not in r.json()

    monkeypatch.setattr(settings, "is_development", True)
    r = await _register(client, "dev@test.com")
    assert r.status_code == 201
    assert len(r.json()["dev_otp"]) == 6


async def test_register_logs_in_directly_when_email_off(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "email_enabled", False)
    r = await _register(client, "noverify@test.com")
    assert r.status_code == 201
    assert r.json()["access_token"]
    assert r.json()["user"]["email"] == "noverify@test.com"
    assert "refresh_token" in r.cookies or client.cookies.get("refresh_token")

    # The account is not marked verified, but it can still log in
    r = await client.post(
        "/auth/login", json={"email": "noverify@test.com", "password": "Password1"}
    )
    assert r.status_code == 200
    assert r.json()["user"]["email_verified"] is False


async def test_email_off_disables_codes_and_reset_links(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "email_enabled", False)
    r = await client.get("/auth/config")
    assert r.json() == {"email_enabled": False}
    r = await client.post("/auth/forgot-password", json={"email": "someone@test.com"})
    assert r.status_code == 400
    r = await client.post("/auth/send-otp", json={"email": "someone@test.com"})
    assert r.status_code == 400


async def test_unverified_login_blocked_when_email_on(client: AsyncClient):
    await _register(client, "blocked@test.com")
    r = await client.post(
        "/auth/login", json={"email": "blocked@test.com", "password": "Password1"}
    )
    assert r.status_code == 403


async def test_otp_locks_after_too_many_wrong_attempts(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "is_development", True)
    code = (await _register(client, "lock@test.com")).json()["dev_otp"]
    wrong = "000000" if code != "000000" else "111111"
    for _ in range(5):
        r = await client.post("/auth/verify-otp", json={"email": "lock@test.com", "code": wrong})
        assert r.status_code == 400
    # Even the right code no longer works — it was burned
    r = await client.post("/auth/verify-otp", json={"email": "lock@test.com", "code": code})
    assert r.status_code == 400


async def test_full_login_refresh_logout_flow(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "is_development", True)
    code = (await _register(client, "flow@test.com")).json()["dev_otp"]

    r = await client.post("/auth/verify-otp", json={"email": "flow@test.com", "code": code})
    assert r.status_code == 200
    access = r.json()["access_token"]
    # Avatar falls back to the email's Gravatar
    assert r.json()["user"]["avatar_url"] == gravatar_url("flow@test.com")
    assert "refresh_token" in r.cookies or client.cookies.get("refresh_token")

    me = await client.get("/auth/me", headers={"Authorization": f"Bearer {access}"})
    assert me.status_code == 200
    assert me.json()["avatar_url"].startswith("https://www.gravatar.com/avatar/")

    r = await client.post("/auth/refresh")
    assert r.status_code == 200
    new_access = r.json()["access_token"]

    r = await client.post("/auth/logout")
    assert r.status_code == 200

    # Every token issued before logout is now revoked
    for tok in (access, new_access):
        r = await client.get("/auth/me", headers={"Authorization": f"Bearer {tok}"})
        assert r.status_code == 401


async def test_reset_link_is_single_use(client: AsyncClient, regular_user, monkeypatch):
    monkeypatch.setattr(settings, "is_development", True)
    r = await client.post("/auth/forgot-password", json={"email": regular_user.email})
    token = r.json()["dev_reset_token"]

    r = await client.post(
        "/auth/reset-password", json={"token": token, "new_password": "Newpass12"}
    )
    assert r.status_code == 200
    r = await client.post(
        "/auth/reset-password", json={"token": token, "new_password": "Other1234"}
    )
    assert r.status_code == 400

    r = await client.post(
        "/auth/login", json={"email": regular_user.email, "password": "Newpass12"}
    )
    assert r.status_code == 200


async def test_forgot_password_hides_token_outside_dev(
    client: AsyncClient, regular_user, monkeypatch
):
    monkeypatch.setattr(settings, "is_development", False)
    r = await client.post("/auth/forgot-password", json={"email": regular_user.email})
    assert "dev_reset_token" not in r.json()


async def test_google_redirect_does_not_auto_login_outside_dev(client: AsyncClient, monkeypatch):
    monkeypatch.setattr(settings, "is_development", False)
    monkeypatch.setattr(settings, "google_client_id", "")
    r = await client.get("/auth/google/redirect", follow_redirects=False)
    assert r.status_code in (302, 307)
    assert "error=google_not_configured" in r.headers["location"]
    assert "token=" not in r.headers["location"]


async def test_admin_user_list_includes_avatars(client: AsyncClient, admin_token, regular_user):
    r = await client.get("/admin/users", headers={"Authorization": f"Bearer {admin_token}"})
    assert r.status_code == 200
    users = r.json()["users"]
    assert users and all(u["avatar_url"] for u in users)


async def test_api_query_blocks_multiple_statements(client: AsyncClient, user_token):
    r = await client.post(
        "/api/query",
        headers={"Authorization": f"Bearer {user_token}"},
        json={"sql": "SELECT 1; DROP TABLE users"},
    )
    assert r.status_code == 400
    assert "Safety Check Failed" in r.json()["detail"]
