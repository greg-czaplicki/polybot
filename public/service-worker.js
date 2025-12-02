importScripts('https://js.pusher.com/beams/service-worker.js')

// Add debugging for push events
self.addEventListener('push', (event) => {
  console.log('[Service Worker] Push event received:', event);
  if (event.data) {
    try {
      const data = event.data.json();
      console.log('[Service Worker] Push data:', data);
    } catch (e) {
      console.log('[Service Worker] Push data (text):', event.data.text());
    }
  }
});

self.addEventListener('notificationclick', (event) => {
  console.log('[Service Worker] Notification clicked:', event);
  event.notification.close();
});

self.addEventListener('notificationclose', (event) => {
  console.log('[Service Worker] Notification closed:', event);
});
