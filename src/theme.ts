/** Tema dell'app: automatico (segue il sistema), chiaro o scuro. Preferenza del dispositivo, non sincronizzata. */
export type Theme = 'auto' | 'light' | 'dark'

const KEY = 'fig-theme'

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch {
    /* senza storage si segue il sistema */
  }
  return 'auto'
}

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'auto') delete root.dataset.theme
  else root.dataset.theme = theme
}

export function writeTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* vale solo per questa sessione */
  }
  applyTheme(theme)
}
