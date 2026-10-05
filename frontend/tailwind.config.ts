import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['Inter', 'system-ui', 'sans-serif'],
        heading: ['Outfit', 'system-ui', 'sans-serif'],
        mono:    ['JetBrains Mono', 'Fira Code', 'Menlo', 'monospace'],
      },
      colors: {
        teal: {
          50:  '#CCFBFA',
          100: '#B1E5E6',
          200: '#7DD3D4',
          300: '#3DB8B9',
          400: '#1EA0A0',
          500: '#0E9999',
          600: '#0B7A7A',
          700: '#085F5F',
          800: '#064848',
          900: '#033030',
        },
      },
      boxShadow: {
        teal:   '0 4px 16px rgba(14,153,153,0.15), 0 1px 4px rgba(14,153,153,0.08)',
        'teal-lg': '0 8px 28px rgba(14,153,153,0.18), 0 2px 8px rgba(14,153,153,0.10)',
        'teal-glow': '0 0 28px rgba(14,153,153,0.22)',
      },
      animation: {
        'pulse-dot':  'pulse-dot 2s infinite ease-in-out',
        'fade-in':    'fade-in 0.22s ease',
        'blink':      'blink 1s step-start infinite',
        'otp-shake':  'otp-shake 0.3s ease',
      },
      keyframes: {
        'pulse-dot': {
          '0%,100%': { transform: 'scale(1)', opacity: '1' },
          '50%':      { transform: 'scale(1.35)', opacity: '0.7' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(6px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'blink': {
          '0%,100%': { opacity: '1' },
          '50%':      { opacity: '0' },
        },
        'otp-shake': {
          '0%,100%': { transform: 'translateX(0)' },
          '25%':      { transform: 'translateX(-4px)' },
          '75%':      { transform: 'translateX(4px)' },
        },
      },
    },
  },
  plugins: [],
};
export default config;
