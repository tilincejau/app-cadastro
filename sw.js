/* Service worker: deixa o app abrir sem internet.
   Com internet ele sempre busca a versão mais nova (atualização na hora);
   sem internet usa a cópia guardada. Ao publicar, aumente a VERSAO. */
const VERSAO = 'lince-cadastro-v12';
const ARQUIVOS = ['./', './index.html', './app.js', './fone.js', './config.js', './manifest.json',
  './logo.png', './logo-branca.png', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './favicon.png',
  './c.html', './og.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSAO).then(c => c.addAll(ARQUIVOS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSAO).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Rede primeiro (até 4 s); se falhar ou demorar, usa o cache.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(caches.open(VERSAO).then(cache => {
    const rede = fetch(req, { cache: 'no-store' }).then(resp => {
      if (resp && resp.ok) cache.put(req, resp.clone());
      return resp;
    });
    const tempo = new Promise(res => setTimeout(res, 4000));
    return Promise.race([rede, tempo.then(() => cache.match(req, { ignoreSearch: true }))])
      .then(r => r || rede)
      .catch(() => cache.match(req, { ignoreSearch: true }));
  }));
});
