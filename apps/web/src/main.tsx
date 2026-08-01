import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import 'maplibre-gl/dist/maplibre-gl.css'
import './styles.css'
import { App } from './App'

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
