/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          400: '#7c3aed',
          500: '#6d28d9'
        }
      },
      backgroundImage: {
        'gradient-brand':    'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        'gradient-dark':     'linear-gradient(135deg, #0f0a1e 0%, #1a0a2e 50%, #0f1a2e 100%)',
        'gradient-button':   'linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%)',
        'gradient-progress': 'linear-gradient(90deg, #7c3aed 0%, #3b82f6 50%, #06b6d4 100%)'
      },
      animation: {
        'fade-in':    'fadeIn 0.3s ease-out',
        'slide-up':   'slideUp 0.4s ease-out',
        'spin-slow':  'spin 1.4s linear infinite'
      },
      keyframes: {
        fadeIn:  { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        slideUp: { '0%': { transform: 'translateY(16px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}
