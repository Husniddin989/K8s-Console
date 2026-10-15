export type Theme = 'light' | 'dark'
const storageKey = 'k8s-ui-theme'

export function initialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(storageKey)
    if (stored === 'light' || stored === 'dark') return stored
  } catch {
    // Storage can be unavailable (private mode); fall back to the system setting.
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  try {
    window.localStorage.setItem(storageKey, theme)
  } catch {
    // Not persisted; the choice still applies to this page.
  }
}
