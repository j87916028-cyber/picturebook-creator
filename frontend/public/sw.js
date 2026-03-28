// Minimal service worker: cache the app shell for instant revisit + offline fallback.
// API calls are NOT cached — they always go to the network.

const CACHE_NAME = 'picturebook-v1'
const SHELL_URLS = ['/', '/manifest.json', '/icon-192.svg', '/icon-512.svg']

// Install: precache the app shell (index.html + icons)
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  )
  self.skipWaiting()
})

// Activate: clean old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  )
  self.clients.claim()
})

// Fetch: network-first for API + hashed assets; cache-first for app shell
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)

  // Never cache API calls or POST/PUT/DELETE requests
  if (url.pathname.startsWith('/api/') || e.request.method !== 'GET') return

  // Hashed assets (/assets/*): cache forever on first fetch (content-hash in filename)
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(cached =>
        cached || fetch(e.request).then(resp => {
          const clone = resp.clone()
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
          return resp
        })
      )
    )
    return
  }

  // App shell (/, /index.html, icons): network-first, fall back to cache
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const clone = resp.clone()
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone))
        return resp
      })
      .catch(() => caches.match(e.request))
  )
})
