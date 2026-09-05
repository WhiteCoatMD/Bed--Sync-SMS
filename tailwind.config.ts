import type { Config } from 'tailwindcss';

/**
 * Matched to Bed Sync's dealer admin (admin-styles.css) so the SMS dashboard
 * does not look like a different product when a dealer clicks through to it.
 * `brand` used to be indigo, which is where the mismatch came from.
 */
const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50:  '#fef2f2',
          100: '#fee2e2',
          500: '#ef4444',   // --secondary-color
          600: '#dc2626',   // --primary-color
          700: '#b91c1c',   // --primary-dark
          800: '#991b1b',
          900: '#dc2626',   // existing brand-900 usages become Bed Sync red
        },
        ink: {
          bg:     '#000000', // --background
          card:   '#111111', // --card-background
          hover:  '#1a1a1a', // --card-hover
          border: '#2a2a2a', // --border
          text:   '#f1f5f9', // --text-dark
          muted:  '#94a3b8', // --text-light
          faint:  '#64748b',
        },
      },
    },
  },
  plugins: [],
};

export default config;
