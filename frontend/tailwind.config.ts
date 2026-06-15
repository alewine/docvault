import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        vault: {
          bg: '#111318',
          surface: '#1C2030',
          elevated: '#242838',
          input: '#2A2F42',
          border: '#2E3448',
          'border-hover': '#3A4055',
          teal: '#00D4AA',
          'teal-hover': '#00B894',
          'teal-bg': 'rgba(0, 212, 170, 0.07)',
          'teal-border': 'rgba(0, 212, 170, 0.25)',
          danger: '#E53E3E',
          'danger-surface': '#2D2030',
          'text-primary': '#E2E8F0',
          'text-bright': '#E2E5EC',
          'text-muted': '#8A93A8',
          'text-soft': '#8B92A5',
          'text-dim': '#555D72',
          btn: '#252830',
          'btn-border': '#2E3340',
        },
      },
    },
  },
  plugins: [],
};
export default config;
