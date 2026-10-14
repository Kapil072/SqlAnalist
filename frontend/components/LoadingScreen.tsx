'use client';
import Image from 'next/image';
import { motion } from 'framer-motion';

interface LoadingScreenProps {
  message?: string;
  subMessage?: string;
  fullScreen?: boolean;
}

const R = 38; // ring radius
const C = 2 * Math.PI * R;

export default function LoadingScreen({
  message = 'Loading…',
  subMessage,
  fullScreen = true,
}: LoadingScreenProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`flex flex-col items-center justify-center select-none overflow-hidden ${
        fullScreen
          ? 'fixed inset-0 z-50 bg-gradient-to-br from-white via-slate-50 to-teal-50/60'
          : 'relative w-full h-full min-h-[220px]'
      }`}
    >
      {/* Soft drifting light blobs */}
      {fullScreen && (
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <motion.div
            className="absolute -top-24 -left-24 w-[420px] h-[420px] rounded-full bg-teal-200/40 blur-3xl"
            animate={{ x: [0, 60, 0], y: [0, 40, 0] }}
            transition={{ duration: 14, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute -bottom-32 -right-24 w-[460px] h-[460px] rounded-full bg-cyan-200/40 blur-3xl"
            animate={{ x: [0, -50, 0], y: [0, -30, 0] }}
            transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
          />
        </div>
      )}

      {/* Delay the fade-in slightly so very fast loads don't flash */}
      <motion.div
        className="relative flex flex-col items-center"
        initial={{ opacity: 0, y: 10, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.12, duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Logo with spinning progress ring */}
        <div className="relative w-24 h-24 flex items-center justify-center">
          <svg className="absolute inset-0" viewBox="0 0 96 96" aria-hidden>
            <defs>
              <linearGradient id="ls-ring" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#0E9999" />
                <stop offset="100%" stopColor="#22D3EE" />
              </linearGradient>
            </defs>
            <circle cx="48" cy="48" r={R} fill="none" stroke="#E2F4F4" strokeWidth="3" />
          </svg>
          <motion.svg
            className="absolute inset-0"
            viewBox="0 0 96 96"
            aria-hidden
            animate={{ rotate: 360 }}
            transition={{ duration: 1.4, repeat: Infinity, ease: 'linear' }}
          >
            <motion.circle
              cx="48"
              cy="48"
              r={R}
              fill="none"
              stroke="url(#ls-ring)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={C}
              animate={{ strokeDashoffset: [C * 0.85, C * 0.3, C * 0.85] }}
              transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
            />
          </motion.svg>

          {/* Orbiting dot */}
          <motion.div
            className="absolute inset-0"
            animate={{ rotate: -360 }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'linear' }}
            aria-hidden
          >
            <span className="absolute left-1/2 -top-0.5 -ml-1 w-2 h-2 rounded-full bg-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.8)]" />
          </motion.div>

          <motion.div
            className="relative w-14 h-14 rounded-2xl bg-white shadow-teal flex items-center justify-center"
            animate={{ scale: [1, 1.05, 1] }}
            transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
          >
            <Image
              src="/logo.png"
              alt="SQLAnalyst"
              width={40}
              height={40}
              priority
              className="rounded-xl object-contain"
            />
          </motion.div>
        </div>

        {/* Text */}
        <motion.p
          className="mt-6 text-[15px] font-semibold text-slate-900 font-heading tracking-tight"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.25, duration: 0.4 }}
        >
          {message}
        </motion.p>
        {subMessage && (
          <motion.p
            className="text-xs text-slate-500 mt-1 text-center max-w-xs px-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.4, duration: 0.4 }}
          >
            {subMessage}
          </motion.p>
        )}

        {/* Indeterminate progress bar */}
        <div
          className="relative mt-5 w-44 h-1 rounded-full bg-teal-100/80 overflow-hidden"
          aria-hidden
        >
          <motion.span
            className="absolute inset-y-0 w-1/3 rounded-full bg-gradient-to-r from-teal-400 via-teal-600 to-cyan-400"
            animate={{ left: ['-35%', '100%'] }}
            transition={{ duration: 1.3, repeat: Infinity, ease: [0.65, 0, 0.35, 1] }}
          />
        </div>
      </motion.div>
    </div>
  );
}
