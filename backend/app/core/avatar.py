"""
Profile pictures.

Order of preference for a user's avatar:
  1. The real photo saved from their Google account (set on Google sign-in).
  2. The Gravatar linked to their email address
     (https://gravatar.com — the standard "profile picture for an email").

Gravatar URLs use `d=404`, so if the email has no Gravatar the image request
fails and the frontend falls back to unavatar.io and finally to initials.
"""

import hashlib

# Old auto-generated placeholders that are not a real profile photo
_PLACEHOLDER_HOSTS = ("unavatar.io/google/", "dicebear")


def gravatar_url(email: str, size: int = 200) -> str:
    digest = hashlib.sha256((email or "").strip().lower().encode()).hexdigest()
    return f"https://www.gravatar.com/avatar/{digest}?s={size}&d=404"


def is_real_photo(url: str | None) -> bool:
    if not url:
        return False
    return not any(p in url for p in _PLACEHOLDER_HOSTS)


def resolve_avatar(user) -> str:
    """Best avatar URL for *user* (any object with .avatar_url and .email)."""
    stored: str | None = getattr(user, "avatar_url", None)
    if stored and is_real_photo(stored):
        return stored
    return gravatar_url(getattr(user, "email", "") or "")
