"""
Email sender utility using smtplib.
In development (SMTP not configured), tokens are logged to the console so you
can still test without a real mail server.
"""
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

from app.config import settings
from app.utils.logger import logger

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _send(to_email: str, subject: str, html: str) -> None:
    """Send an HTML email via SMTP. Raises on error (caller handles)."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = settings.smtp_from
    msg["To"] = to_email
    msg.attach(MIMEText(html, "html"))

    with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port) as server:
        server.login(settings.smtp_user, settings.smtp_password)
        server.sendmail(settings.smtp_from, to_email, msg.as_string())


def _btn(url: str, label: str) -> str:
    """Return an HTML button anchor tag."""
    return (
        f'<a href="{url}" style="display:inline-block;background:#6366f1;color:#fff;'
        f'padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;'
        f'font-size:15px;">{label}</a>'
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def send_welcome_email(to_email: str, name: str) -> None:
    """Send a welcome email. Silently skips if SMTP is not configured."""
    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL SKIP] Welcome email would have been sent to {to_email} "
            "(SMTP not configured)"
        )
        return
    html = f"""
    <html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;">
      <h2 style="color:#6366f1;">Hi {name}, welcome aboard! 🎉</h2>
      <p>Your account is ready. Start asking questions about your data:</p>
      {_btn(settings.app_url, "Open SQL Analyst AI")}
      <p style="margin-top:32px;color:#666;">— The SQL Analyst AI Team</p>
    </body></html>
    """
    try:
        _send(to_email, "Welcome to SQL Analyst AI 🎉", html)
        logger.info(f"[EMAIL] Welcome email sent to {to_email}")
    except Exception as exc:
        logger.warning(f"[EMAIL] Failed to send welcome email to {to_email}: {exc}")


def send_verification_email(to_email: str, name: str, token: str) -> None:
    """
    Send an email-verification link.
    In dev mode (no SMTP) the token is printed to the log instead.
    """
    verify_url = f"{settings.app_url}/auth/verify-email?token={token}"

    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL DEV] Verification link for {to_email}:\n  {verify_url}\n"
            f"  (copy this URL to verify without SMTP)"
        )
        return

    html = f"""
    <html><body style="font-family:sans-serif;max-width:600px;margin:auto;padding:40px;">
      <h2 style="color:#6366f1;">Verify your email, {name}</h2>
      <p>Click the button below to confirm your email address.
         The link expires in 24 hours.</p>
      {_btn(verify_url, "Verify Email Address")}
      <p style="margin-top:24px;color:#888;font-size:13px;">
        If you did not create an account, you can safely ignore this email.
      </p>
    </body></html>
    """
    try:
        _send(to_email, "Verify your SQL Analyst AI account", html)
        logger.info(f"[EMAIL] Verification email sent to {to_email}")
    except Exception as exc:
        logger.warning(f"[EMAIL] Failed to send verification email to {to_email}: {exc}")


def send_password_reset_email(to_email: str, name: str, token: str) -> None:
    """
    Send a password-reset link.
    In dev mode (no SMTP) the token is printed to the log instead.
    """
    reset_url = f"{settings.app_url}/auth.html?reset_token={token}"

    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL DEV] Password reset link for {to_email}:\n  {reset_url}\n"
            f"  (copy this URL to reset without SMTP)"
        )
        return

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
    except Exception as exc:
        logger.warning(f"[EMAIL] Failed to send reset email to {to_email}: {exc}")



def send_otp_email(to_email: str, name: str, code: str) -> bool:
    """
    Send a 6-digit OTP for email verification.
    Returns True if email was sent, False if SMTP not configured or send failed.
    In dev/fallback mode the code is printed to the server log.
    """
    if not settings.smtp_configured:
        logger.info(
            f"[EMAIL DEV] OTP for {to_email}  →  {code}  "
            f"(SMTP not configured — check server logs)"
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
        logger.warning(f"[EMAIL] Failed to send OTP to {to_email}: {exc}")
        return False
