"""
Email sender utility using smtplib, or the Brevo HTTP API when BREVO_API_KEY
is set (for hosts that block SMTP ports, e.g. Render free).
In development (SMTP not configured), tokens are logged to the console so you
can still test without a real mail server.
"""

import smtplib
import socket
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import httpx

from app.config import settings
from app.utils.logger import logger

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _password() -> str:
    # Gmail shows App Passwords as "abcd efgh ijkl mnop" — the spaces are not part of it
    return settings.smtp_password.replace(" ", "").strip()


BREVO_URL = "https://api.brevo.com/v3/smtp/email"


def _send_brevo(to_email: str, subject: str, html: str) -> None:
    """Send an HTML email through Brevo's HTTPS API. Raises on error."""
    response = httpx.post(
        BREVO_URL,
        headers={"api-key": settings.brevo_api_key, "accept": "application/json"},
        json={
            "sender": {"name": "SQLAnalyst", "email": settings.smtp_from or settings.smtp_user},
            "to": [{"email": to_email}],
            "subject": subject,
            "htmlContent": html,
        },
        timeout=settings.smtp_timeout,
    )
    response.raise_for_status()


def _send(to_email: str, subject: str, html: str) -> None:
    """Send an HTML email via Brevo (if configured) or SMTP. Raises on error (caller handles).

    Port 465 uses SSL from the start; any other port (587, 25, 2525) uses
    STARTTLS. Both work with Gmail.
    """
    if settings.brevo_api_key:
        _send_brevo(to_email, subject, html)
        return

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from or settings.smtp_user
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html"))

    context = ssl.create_default_context()
    timeout = settings.smtp_timeout
    server: smtplib.SMTP
    if settings.smtp_port == 465:
        server = smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=timeout, context=context
        )
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout)
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
    with server:
        server.login(settings.smtp_user, _password())
        server.sendmail(msg["From"], [to_email], msg.as_string())


def explain_smtp_error(exc: Exception) -> str:
    """Turn a low-level SMTP/socket error into a fix the admin can act on."""
    host = settings.smtp_host
    if isinstance(exc, httpx.HTTPStatusError):
        if settings.brevo_api_key.startswith("xsmtpsib-"):
            return (
                "BREVO_API_KEY is a Brevo SMTP key (xsmtpsib-...). The API needs an API key"
                " (xkeysib-...) from app.brevo.com/settings/keys/api."
            )
        hint = (
            f"Brevo rejected the email (HTTP {exc.response.status_code}): {exc.response.text}."
            " Check BREVO_API_KEY and that SMTP_FROM is a verified sender in Brevo."
        )
        return hint
    if isinstance(exc, httpx.HTTPError):
        return f"could not reach the Brevo API. [{type(exc).__name__}: {exc}]"
    if isinstance(exc, smtplib.SMTPAuthenticationError):
        hint = (
            "the mail server rejected SMTP_USER / SMTP_PASSWORD."
            " For Gmail, turn on 2-Step Verification and use a 16-letter App Password"
            " (myaccount.google.com/apppasswords), not your normal password."
        )
    elif isinstance(exc, smtplib.SMTPSenderRefused):
        hint = "SMTP_FROM is not allowed to send — for Gmail make it the same as SMTP_USER."
    elif isinstance(exc, smtplib.SMTPRecipientsRefused):
        hint = "the recipient address was refused by the mail server."
    elif isinstance(exc, ssl.SSLError):
        hint = (
            f"SSL handshake failed on port {settings.smtp_port}. Use SMTP_PORT=465 (SSL)"
            " or SMTP_PORT=587 (STARTTLS) — they are not interchangeable."
        )
    elif isinstance(exc, socket.gaierror):
        hint = f"cannot find mail server '{host}' — check SMTP_HOST and your internet connection."
    elif isinstance(exc, (TimeoutError, socket.timeout, ConnectionRefusedError, OSError)):
        hint = (
            f"could not reach {host}:{settings.smtp_port} — a firewall, antivirus or network"
            " is blocking it. Try SMTP_PORT=587 (or 465 if you were on 587)."
        )
    else:
        hint = "unexpected mail error."
    return f"{hint} [{type(exc).__name__}: {exc}]"


def _btn(url: str, label: str) -> str:
    """Return an HTML button anchor tag."""
    return (
        f'<a href="{url}" style="display:inline-block;background:#6366f1;color:#fff;'
        f"padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;"
        f'font-size:15px;">{label}</a>'
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def send_password_reset_email(to_email: str, name: str, token: str) -> bool:
    """
    Send a password-reset link.
    Returns True if sent, False if SMTP not configured or failed.
    In dev mode (no SMTP) the token is printed to the log instead.
    """
    reset_url = f"{settings.frontend_url}/auth?reset_token={token}"

    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL DEV] Password reset link for {to_email}:\n  {reset_url}\n"
            f"  (visit this URL to reset)"
        )
        return False

    html = f"""
    <html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;">
      <h2 style="color:#6366f1;">Reset your password, {name}</h2>
      <p>We received a request to reset the password for your account.
         Click the button below — this link expires in 1 hour.</p>
      {_btn(reset_url, "Reset Password")}
      <p style="margin-top:24px;color:#888;font-size:13px;">
        If you did not request this, you can safely ignore this email.
        Your password will not change.
      </p>
    </body></html>
    """
    try:
        _send(to_email, "Reset your SQL Analyst AI password", html)
        logger.info(f"[EMAIL] Password reset email sent to {to_email}")
        return True
    except Exception as exc:
        logger.error(f"[EMAIL] Reset email to {to_email} failed — {explain_smtp_error(exc)}")
        return False


def send_otp_email(to_email: str, name: str, code: str) -> bool:
    """
    Send a 6-digit OTP for email verification.
    Returns True if email was sent, False if SMTP not configured or send failed.
    In dev/fallback mode the code is printed to the server log.
    """
    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL DEV] OTP for {to_email}  →  {code}  (SMTP not configured — check server logs)"
        )
        return False

    html = f"""
    <html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;">
      <h2 style="color:#6366f1;">Hi {name}, here is your verification code</h2>
      <p style="font-size:15px;color:#374151;">
        Use the code below to verify your email address.
        It expires in <strong>10 minutes</strong>.
      </p>
      <div style="margin:32px auto;width:fit-content;background:#f3f4f6;
                  border-radius:12px;padding:24px 48px;text-align:center;">
        <span style="font-size:40px;font-weight:800;letter-spacing:12px;
                     color:#6366f1;">{code}</span>
      </div>
      <p style="color:#6b7280;font-size:13px;">
        If you did not create an account, you can safely ignore this email.
      </p>
    </body></html>
    """
    try:
        _send(to_email, "Your SQLAnalyst verification code", html)
        logger.info(f"[EMAIL] OTP sent to {to_email}")
        return True
    except Exception as exc:
        logger.error(f"[EMAIL] OTP email to {to_email} failed — {explain_smtp_error(exc)}")
        return False
