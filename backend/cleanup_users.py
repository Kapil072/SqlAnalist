"""
cleanup_users.py
----------------
Run this script to clean out non-admin users, expired OTPs, and
optionally all chat history from the app database.

Usage:
    python cleanup_users.py              # shows current state + asks before deleting
    python cleanup_users.py --force      # deletes without asking
    python cleanup_users.py --show-only  # only shows current state, no deletions

Database location: backend/data/app.db  (SQLite)
"""

import sys
import asyncio
import os

# Make sure the backend package is on the path
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, BACKEND_DIR)

# Change working directory to backend so relative DB paths resolve correctly
os.chdir(BACKEND_DIR)

from dotenv import load_dotenv
load_dotenv(os.path.join(BACKEND_DIR, '.env'))

from app.db.session import AsyncSessionLocal
from app.models.user import User
from app.models.otp import OTPCode
from app.models.chat_history import ChatMessage
from sqlalchemy import select, delete
from datetime import datetime, timezone


async def show_state(db):
    """Print current DB state."""
    users = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
    otps  = (await db.execute(select(OTPCode))).scalars().all()
    msgs  = (await db.execute(select(ChatMessage))).scalars().all()

    print('\n' + '='*60)
    print(f'  DATABASE: backend/data/app.db')
    print('='*60)

    print(f'\n  USERS ({len(users)})')
    print('  ' + '-'*56)
    for u in users:
        tag = '[ADMIN]' if u.role == 'admin' else '[USER] '
        ver = 'verified' if u.email_verified else 'NOT verified'
        print(f'  {tag}  {u.email:<32}  {ver}  {str(u.created_at)[:19]}')

    now = datetime.now(timezone.utc)
    print(f'\n  OTP CODES ({len(otps)})')
    print('  ' + '-'*56)
    if otps:
        for o in otps:
            status = 'EXPIRED' if datetime.utcnow() > o.expires_at.replace(tzinfo=None) else 'active'
            print(f'  {o.email:<32}  code={o.code}  {status}')
    else:
        print('  (none)')

    print(f'\n  CHAT MESSAGES ({len(msgs)})')
    if msgs:
        # Group by user
        from collections import Counter
        counts = Counter(str(m.user_id) for m in msgs)
        for uid, count in counts.items():
            print(f'  user_id={uid[:8]}...  {count} messages')
    else:
        print('  (none)')

    print('='*60)
    return users, otps, msgs


async def cleanup(force=False, show_only=False):
    async with AsyncSessionLocal() as db:
        users, otps, msgs = await show_state(db)

        if show_only:
            print('\n  --show-only mode: no changes made.\n')
            return

        # Count what will be deleted
        non_admin_users = [u for u in users if u.role != 'admin']

        print(f'\n  Will delete:')
        print(f'    - {len(non_admin_users)} non-admin user(s)')
        print(f'    - all {len(otps)} OTP code(s)')
        print(f'    - all {len(msgs)} chat message(s)')

        if not non_admin_users and not otps and not msgs:
            print('\n  Nothing to clean up. Database is already clean.\n')
            return

        if not force:
            answer = input('\n  Proceed? (yes/no): ').strip().lower()
            if answer not in ('yes', 'y'):
                print('  Cancelled.\n')
                return

        # Delete OTPs first
        await db.execute(delete(OTPCode))
        print(f'  Deleted {len(otps)} OTP code(s)')

        # Delete chat messages for non-admin users
        for u in non_admin_users:
            await db.execute(delete(ChatMessage).where(ChatMessage.user_id == u.id))

        # Delete non-admin users
        for u in non_admin_users:
            await db.delete(u)
            print(f'  Deleted user: {u.email}')

        await db.commit()

        print('\n  Cleanup complete. Final state:')
        await show_state(db)


if __name__ == '__main__':
    force     = '--force'     in sys.argv
    show_only = '--show-only' in sys.argv
    asyncio.run(cleanup(force=force, show_only=show_only))
