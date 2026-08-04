import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import { App } from './App'
import { watchSystemTheme } from './lib/theme'

// public/appearance.js has already stamped the stored choice; this only keeps
// a `system` choice following the operating system while the tab stays open.
watchSystemTheme()

registerSW({
  immediate: true,
  onRegisterError(error) {
    console.error('Flightmap service worker registration failed', error)
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
