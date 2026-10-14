'use client';
import { useEffect, useMemo, useState } from 'react';

interface Props {
  /** Avatar URL from the backend (Google photo or Gravatar) */
  src?: string | null;
  /** Used for the unavatar.io fallback and for initials */
  email?: string | null;
  name?: string | null;
  /** Tailwind size / shape classes, e.g. "w-8 h-8 rounded-lg" */
  className?: string;
  /** Extra classes for the initials fallback (gradient, font size) */
  fallbackClassName?: string;
}

/**
 * Shows the profile picture for a user's email address.
 *
 * Tries, in order:
 *   1. `src` from the backend (Google account photo, or Gravatar)
 *   2. unavatar.io lookup by email (Gravatar + other public providers)
 *   3. The user's initial on a coloured tile
 *
 * If an image fails to load it moves on to the next source automatically.
 */
export default function Avatar({
  src,
  email,
  name,
  className = 'w-8 h-8 rounded-lg',
  fallbackClassName = '',
}: Props) {
  const sources = useMemo(() => {
    const list: string[] = [];
    if (src) list.push(src);
    const e = (email || '').trim().toLowerCase();
    if (e) list.push(`https://unavatar.io/${encodeURIComponent(e)}?fallback=false`);
    return Array.from(new Set(list));
  }, [src, email]);

  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
  }, [sources]);

  const initial = (name?.trim()?.charAt(0) || email?.trim()?.charAt(0) || 'U').toUpperCase();
  const current = sources[index];

  if (!current) {
    return (
      <div
        aria-label={name || email || 'User'}
        className={`${className} bg-gradient-to-br from-teal-500 to-teal-700 flex items-center
                    justify-center text-white font-bold flex-shrink-0 select-none ${fallbackClassName}`}
      >
        {initial}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      key={current}
      src={current}
      alt={name || email || 'User'}
      referrerPolicy="no-referrer"
      loading="lazy"
      onError={() => setIndex(i => i + 1)}
      className={`${className} object-cover flex-shrink-0`}
    />
  );
}
