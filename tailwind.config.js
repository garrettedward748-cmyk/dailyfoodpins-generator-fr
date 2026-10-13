/**
 * Design tokens for the dashboard.
 *
 * `darkMode: 'class'` rather than the media query: the theme is a choice the
 * operator makes and it is remembered in localStorage, so the OS setting is a
 * starting point rather than the answer. layout.ts sets the class on <html>
 * before first paint — see the boot script there.
 *
 * `content` scans the server-rendered templates. They are TypeScript files
 * holding HTML in tagged template literals, which Tailwind reads as plain text
 * like any other file: a class name in a string is found the same way it would
 * be in a .html file. Utilities used inside @apply are emitted regardless, so
 * the component layer in styles/input.css does not depend on this.
 */
export default {
  darkMode: 'class',
  content: ['./src/web/**/*.ts'],
  theme: {
    extend: {
      colors: {
        /* Surfaces: a cool, airy light theme; the dark one is a choice made
           with the switch in the header. Named by role, not by shade. */
        page: { DEFAULT: '#f4f5fb', dark: '#0f1117' },
        surface: { DEFAULT: '#ffffff', dark: '#171a23' },
        edge: { DEFAULT: '#e7e8f3', dark: '#262a38' },
        fill: { DEFAULT: '#f1f2fa', dark: '#1e2230' },

        /* The accent is a soft violet. Red is kept for what went wrong only,
           so an error never looks like the brand and the brand never alarms. */
        brand: { DEFAULT: '#6c5ce7', soft: 'rgba(108, 92, 231, 0.10)' },
        danger: { DEFAULT: '#e5484d', soft: 'rgba(229, 72, 77, 0.10)' },
        emerald: { DEFAULT: '#12b886', soft: 'rgba(18, 184, 134, 0.12)' },
        amber: { DEFAULT: '#f59f00', soft: 'rgba(245, 159, 0, 0.12)' },
      },
      fontFamily: {
        /* The device's own font: nothing to download, text shows at once. */
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        soft: '0 1px 2px rgba(20, 22, 50, 0.04), 0 4px 16px rgba(20, 22, 50, 0.05)',
        lift: '0 2px 4px rgba(20, 22, 50, 0.06), 0 10px 28px rgba(20, 22, 50, 0.09)',
      },
    },
  },
  plugins: [],
};
