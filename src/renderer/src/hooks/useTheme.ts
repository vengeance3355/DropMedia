import { useEffect } from 'react'

export function useTheme() {
  useEffect(() => {
    async function apply() {
      const theme = (await window.api.getSetting('theme') as string) ?? 'dark'
      const root  = document.documentElement
      root.classList.remove('dark', 'light')
      root.classList.add(theme)

      // Tema değişikliğini dinle
      const interval = setInterval(async () => {
        const t = (await window.api.getSetting('theme') as string) ?? 'dark'
        if (!root.classList.contains(t)) {
          root.classList.remove('dark', 'light')
          root.classList.add(t)
        }
      }, 2000)

      return () => clearInterval(interval)
    }
    apply()
  }, [])
}
