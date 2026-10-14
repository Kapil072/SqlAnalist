'use client';
import { motion } from 'framer-motion';

// A template re-mounts on every navigation, so each dashboard page fades in on arrival
export default function DashboardTemplate({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      className="h-full"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  );
}
