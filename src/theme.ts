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

/** Colore della barra di stato per tema: lo stesso sfondo dell'app (--bg in styles.css, e index.html). */
const BAR = { light: '#f3eee6', dark: '#141118' }

export function applyTheme(theme: Theme) {
  const root = document.documentElement
  if (theme === 'auto') delete root.dataset.theme
  else root.dataset.theme = theme
  // La barra di stato segue il tema scelto a mano; in automatico ogni <meta> torna al colore del suo tema di sistema.
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = BAR[theme === 'auto' ? (meta.media.includes('dark') ? 'dark' : 'light') : theme]
  }
}

export function writeTheme(theme: Theme) {
  try {
    localStorage.setItem(KEY, theme)
  } catch {
    /* vale solo per questa sessione */
  }
  applyTheme(theme)
}
