import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const reg of registrations) reg.unregister()
  })
  navigator.serviceWorker.getRegistrations().then(() => caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))))
}

createRoot(document.getElementById('root')).render(<App />)
