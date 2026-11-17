const CACHE = 'oekaki-v5';
const CDN_URLS = [
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore-compat.js',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(cache => {
      cache.addAll(['./index.html', './manifest.json', './icon.svg']);
      return Promise.allSettled(CDN_URLS.map(url => cache.add(url)));
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase の通信（認証・Firestore）はキャッシュしない
  if (/googleapis\.com|firebaseio\.com|identitytoolkit/.test(url.hostname)) return;

  // 自サイトのファイルはネット優先（更新をすぐ反映）、オフライン時はキャッシュ
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }
  // CDN はキャッシュ優先
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
      return res;
    }))
  );
});

// 通知をタップしたらアプリの受信箱を開く
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './index.html#inbox';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) { c.navigate(url).catch(() => {}); return c.focus(); }
      }
      return self.clients.openWindow(url);
    })
  );
});

// アプリを閉じていても届く通知（Web Push）
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || '新しい絵が届きました', {
    body: d.body || 'タップして見てみよう 🎨',
    icon: 'icon.svg', badge: 'icon.svg',
    tag: 'oekaki-new', renotify: true,
    data: { url: d.url || './index.html#inbox' },
  }));
});
