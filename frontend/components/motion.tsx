'use client';
/**
 * Shared Framer Motion presets so every screen moves the same way.
 * Springs are tuned to feel quick and soft (no bouncy overshoot on UI chrome).
 */
import {
  animate,
  AnimatePresence,
  LayoutGroup,
  motion,
  MotionConfig,
  type Transition,
  type Variants,
} from 'framer-motion';

export { animate, AnimatePresence, LayoutGroup, motion };

// ── Transitions ───────────────────────────────────────────────
export const spring: Transition = { type: 'spring', stiffness: 380, damping: 32, mass: 0.8 };
export const softSpring: Transition = { type: 'spring', stiffness: 220, damping: 26 };
export const ease: Transition = { duration: 0.28, ease: [0.22, 1, 0.36, 1] };

// ── Variants ──────────────────────────────────────────────────
export const fadeUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: ease },
};

export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.22 } },
};

/** Parent that reveals its `fadeUp` children one after another */
export const stagger = (gap = 0.06, delay = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren: gap, delayChildren: delay } },
});

/** Height-auto collapse for accordions and banners */
export const collapse = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: { ...ease, opacity: { duration: 0.2 } } },
  exit: { height: 0, opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } },
} as const;

/** Small press feedback for buttons and cards */
export const press = { whileHover: { y: -2 }, whileTap: { scale: 0.97 } } as const;

// ── Building blocks ───────────────────────────────────────────
/** Respects the OS "reduce motion" setting across the whole app */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

/** Dimmed backdrop + springy dialog. Render it inside <AnimatePresence>. */
export function Modal({
  onClose,
  children,
  className = '',
  labelledBy,
}: {
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  labelledBy?: string;
}) {
  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={className}
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0, transition: spring }}
        exit={{ opacity: 0, scale: 0.97, y: 8, transition: { duration: 0.15 } }}
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

/** Three bouncing dots — used for "thinking" states */
export function TypingDots({ className = 'bg-teal-500' }: { className?: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden>
      {[0, 1, 2].map(i => (
        <motion.span
          key={i}
          className={`w-1.5 h-1.5 rounded-full ${className}`}
          animate={{ y: [0, -4, 0], opacity: [0.35, 1, 0.35] }}
          transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
        />
      ))}
    </span>
  );
}

/** Light shimmering placeholder bar */
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton rounded-lg ${className}`} />;
}
