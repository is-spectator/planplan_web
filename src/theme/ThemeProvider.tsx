import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'light' | 'dark' | 'system'
const themeKey = 'planplan-theme'
const ThemeContext = createContext<{ theme: Theme; setTheme: (theme: Theme) => void } | null>(null)

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(themeKey)
    if (stored === 'light' || stored === 'dark') return stored
  } catch { /* A blocked storage area must not prevent opening the app. */ }
  return 'system'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, updateTheme] = useState<Theme>(readTheme)

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
      document.documentElement.style.colorScheme = resolved
    }
    apply()
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])

  useEffect(() => {
    const synchronize = (event: StorageEvent) => {
      if (event.key === themeKey || event.key === null) updateTheme(readTheme())
    }
    window.addEventListener('storage', synchronize)
    return () => window.removeEventListener('storage', synchronize)
  }, [])

  function setTheme(next: Theme) {
    updateTheme(next)
    try { localStorage.setItem(themeKey, next) } catch { /* Keep this session usable. */ }
  }

  return <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
}

// Kept with the context so consumers cannot accidentally create a second provider.
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme() {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('ThemeProvider is required')
  return context
}
