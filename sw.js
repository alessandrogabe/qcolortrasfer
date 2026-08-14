// Previous cache markers kept for regression tests:
// qcolortrasfer-v2.2.1-ios-optical-overlay
// qcolortrasfer-v2.2.2-start-optical
// qcolortrasfer-v2.6.1-aux-fixed-geometry
// qcolortrasfer-v2.7.0-multi-aux-overlay
const CACHE = 'qcolortrasfer-v2.8.0-refined-tracked-qar2';

const CORE = [
  './', './index.html', './styles.css', './tx-flow.css', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  './js/ui-shell.js', './js/tx-optical-view.js', './js/tx-flow-ui.js', './js/rx-performance-policy.js', './js/rx-detection-overlay.js', './js/tx-profile-policy.js', './js/tx-aux-repair-v2.js',
  './js/app.js', './js/crc32.js', './js/fountain.js', './js/protocol.js', './js/aux-repair.js', './js/optical.js',
  './js/color-code.js', './js/adaptive-scheduler.js', './js/high-throughput.js', './js/tx-worker.js',
  './js/rx-roi.js', './js/tracked-qr.js', './js/qr-worker.js'
];

const EXTERNAL = new Set(['https://esm.sh', 'https://cdn.jsdelivr.net']);
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('qcolortrasfer-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const request=event.request;if(request.method!=='GET')return;const url=new URL(request.url);
  if(EXTERNAL.has(url.origin)){event.respondWith(caches.open(CACHE).then(async cache=>{const cached=await cache.match(request);try{const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;}catch{return cached||Response.error();}}));return;}
  if(url.origin!==self.location.origin)return;
  if(request.mode==='navigate'){event.respondWith(fetch(request).then(response=>{caches.open(CACHE).then(cache=>cache.put('./index.html',response.clone()));return response;}).catch(()=>caches.match('./index.html')));return;}
  const runtimeCode=/\/(js\/|sw\.js$)/.test(url.pathname);
  if(runtimeCode){event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response;}).catch(()=>caches.match(request)));return;}
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response;})));
});
