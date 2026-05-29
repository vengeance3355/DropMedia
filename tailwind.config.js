/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}', './src/renderer/index.html'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f0e7ff',
          100: '#d9c2ff',
          200: '#b388ff',
          300: '#8e4fff',
          400: '#7c3aed',
          500: '#6d28d9',
          600: '#5b21b6',
          700: '#4c1d95',
          800: '#3b1070',
          900: '#2e0a5c'
        },
        accent: {
          blue: '#3b82f6',
          indigo: '#6366f1',
          purple: '#8b5cf6',
          pink: '#ec4899'
        },
        surface: {
          DEFAULT: 'rgba(15, 10, 30, 0.95)',
          card: 'rgba(255, 255, 255, 0.05)',
          hover: 'rgba(255, 255, 255, 0.08)',
          border: 'rgba(255, 255, 255, 0.1)'
        }
      },
      backgroundImage: {
        'gradient-brand': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        'gradient-dark': 'linear-gradient(135deg, #0f0a1e 0%, #1a0a2e 50%, #0f1a2e 100%)',
        'gradient-card': 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.03) 100%)',
        'gradient-button': 'linear-gradient(135deg, #7c3aed 0%, #3b82f6 100%)',
        'gradient-progress': 'linear-gradient(90deg, #7c3aed 0%, #3b82f6 50%, #06b6d4 100%)'
      },
      backdropBlur: {
        xs: '2px'
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'fade-in': 'fadeIn 0.2s ease-out',
        'shimmer': 'shimmer 2s infinite',
        'slide-right': 'slideRight 1.4s ease-in-out infinite'
      },
      keyframes: {
        slideUp: {
          '0%': { transform: 'translateY(10px)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' }
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        },
        slideRight: {
          '0%':   { transform: 'translateX(-100%)' },
          '50%':  { transform: 'translateX(200%)' },
          '100%': { transform: 'translateX(200%)' }
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif']
      }
    }
  },
  plugins: []
}
