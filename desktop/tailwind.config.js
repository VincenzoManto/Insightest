/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx,html}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        accent: {
          DEFAULT: '#00d86f',
          50: '#e6fbf1',
          100: '#ccf7e3',
          200: '#99efc7',
          300: '#66e7ab',
          400: '#33df8f',
          500: '#00d86f',
          600: '#00ad59',
          700: '#008243',
          800: '#00562c',
          900: '#002b16',
        },
        accent2: '#4a3aa7',
        good: '#0ca30c',
        warning: '#fab219',
        critical: '#d03b3b',
        surface: '#ffffff',
        page: '#f6f7f5',
        sidebar: { DEFAULT: '#0e1311', hover: '#181f1c', border: '#222b27', text: '#a3aea8' },
        ink: {
          primary: '#0b0b0b',
          secondary: '#52514e',
          muted: '#898781',
        },
        gridline: '#e4e6e1',
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['ui-monospace', '"Cascadia Code"', 'Consolas', 'Menlo', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(11,11,11,0.04), 0 1px 1px rgba(11,11,11,0.03)',
        card: '0 1px 3px rgba(11,11,11,0.05), 0 8px 24px -12px rgba(11,11,11,0.10)',
        'card-hover': '0 2px 6px rgba(11,11,11,0.06), 0 16px 32px -14px rgba(11,11,11,0.16)',
        glow: '0 0 0 4px rgba(0,216,111,0.12)',
      },
      borderRadius: {
        xl2: '1.1rem',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.35s ease both',
      },
    },
  },
  plugins: [],
};
