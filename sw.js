/* Service worker: deixa o app abrir sem internet.
   Ao publicar uma versão nova, aumente o número da VERSAO. */
const VERSAO = 'lince-cadastro-v7';
const ARQUIVOS = ['./', './index.html', './app.js', './fone.js', './config.js', './manifest.json',
  './logo.png', './logo-branca.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.png', './c.html', './og.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Arquivos do app: responde do cache na hora e atualiza em segundo plano.
// Chamadas à planilha (Apps Script) passam direto, sem cache.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSAO).then(cache =>
    cache.match(req, { ignoreSearch: true }).then(hit => {
      const rede = fetch(req).then(resp => { if (resp && resp.ok) cache.put(req, resp.clone()); return resp; }).catch(() => hit);
      return hit || rede;
    })
  ));
});
