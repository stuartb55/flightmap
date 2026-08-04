/*
 * Stamps the stored theme and density on <html> before the first paint, so a
 * reader who chose the light theme never sees a frame of the dark one. It runs
 * as a blocking classic script because the application bundle is a module and
 * therefore deferred until after the document has painted.
 *
 * The storage key, the accepted values and the default all mirror
 * src/lib/theme.ts, which owns them; theme.bootstrap.test.ts fails if the two
 * drift apart.
 */
(function () {
  var root = document.documentElement
  var theme = 'dark'
  var density = 'comfortable'
  try {
    var stored = JSON.parse(localStorage.getItem('flightmap.appearance.v1') || 'null')
    if (stored && typeof stored === 'object') {
      if (stored.theme === 'light' || stored.theme === 'dark') {
        theme = stored.theme
      } else if (stored.theme === 'system') {
        theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
      }
      if (stored.density === 'compact') density = 'compact'
    }
  } catch {
    // An unreadable preference must never stop the page rendering.
  }
  root.setAttribute('data-theme', theme)
  root.setAttribute('data-density', density)
  var meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#ffffff' : '#070b10')
})()
