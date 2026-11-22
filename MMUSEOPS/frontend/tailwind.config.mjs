/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
        heading: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      colors: {
        accent: {
          50: '#f0f7ff',
          100: '#e0eeff',
          200: '#c2dfff',
          300: '#96c7ff',
          400: '#5fa8ff',
          500: '#0071e3',
          600: '#0063c7',
          700: '#004e9e',
          800: '#003d7d',
          900: '#00305f',
        },
        surface: {
          0: '#ffffff',
          50: '#f5f5f7',
          100: '#f0f0f2',
          200: '#e5e5ea',
          300: '#d0d0d5',
          400: '#a1a1a6',
          500: '#86868b',
          600: '#6e6e73',
          700: '#48484a',
          800: '#2a2a2c',
          900: '#1d1d1f',
        },
      },
      fontFamily: {
        inherit: ['inherit'],
      },
      boxShadow: {
        'card': '0 1px 2px rgba(0,0,0,0.04), 0 1px 0 rgba(0,0,0,0.02)',
        'card-hover': '0 4px 20px rgba(0,0,0,0.08), 0 1px 0 rgba(0,0,0,0.02)',
        'panel': '0 1px 3px rgba(0,0,0,0.05), 0 1px 0 rgba(0,0,0,0.02)',
        'float': '0 8px 40px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.04)',
      },
    },
  },
  plugins: [],
}
