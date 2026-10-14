"""
test_smtp.py
------------
Checks the SMTP settings in backend/.env by sending one test email, and
prints the exact reason if it fails.

Usage (from the backend folder):
    ..\\.venv\\Scripts\\python test_smtp.py you@example.com
"""

import os
import sys

BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)
os.chdir(BACKEND_DIR)

from dotenv import load_dotenv  # noqa: E402

load_dotenv(os.path.join(BACKEND_DIR, ".env"))

from app.config import settings  # noqa: E402
from app.core.email import _send, explain_smtp_error  # noqa: E402


def main() -> int:
    to = sys.argv[1] if len(sys.argv) > 1 else settings.smtp_user
    print(f"SMTP_HOST = {settings.smtp_host or '(empty)'}")
    print(
        f"SMTP_PORT = {settings.smtp_port}  ({'SSL' if settings.smtp_port == 465 else 'STARTTLS'})"
    )
    print(f"SMTP_USER = {settings.smtp_user or '(empty)'}")
    print(f"SMTP_PASSWORD set = {bool(settings.smtp_password)}")
    print(f"SMTP_FROM = {settings.smtp_from}")
    if not settings.smtp_configured:
        print("\nFAILED: SMTP_HOST, SMTP_USER and SMTP_PASSWORD must all be set in backend/.env")
        return 1
    if not to:
        print("\nUsage: python test_smtp.py you@example.com")
        return 1
    print(f"\nSending a test email to {to} ...")
    try:
        _send(to, "SQLAnalyst SMTP test", "<p>SMTP is working.</p>")
    except Exception as exc:  # noqa: BLE001
        print(f"\nFAILED: {explain_smtp_error(exc)}")
        return 1
    print("\nOK: email sent. Check the inbox (and spam folder).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
