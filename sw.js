/* 婚礼通知备忘录 · Service Worker */
var CACHE = 'wedding-memo-gh-v4.4.0';

/* 会随版本变的代码/页面：必须网络优先，否则升级时会出现「新 HTML 配旧 JS」 */
var FRESH = ['index.html', 'rescue.html', 'app.js', 'styles.css', 'manifest.webmanifest'];
/* 几乎不变的资源：缓存优先，省流量 */
var STATIC = ['icon-180.png', 'icon-512.png'];

var ASSETS = ['./'].concat(FRESH.map(function (f) { return './' + f; }))
  .concat(STATIC.map(function (f) { return './' + f; }));

function isFresh(url) {
  var p = url.split('?')[0];
  return FRESH.some(function (f) { return p.slice(-(f.length + 1)) === '/' + f; });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      // 单个资源抓不到也别让整个安装失败，否则新版本永远装不上
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () { });
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  // 云服务数据面请求永不走缓存
  if (req.url.indexOf('/.cloud/') >= 0) return;
  if (req.url.indexOf(self.location.origin) !== 0) return;

  /* 导航 + 代码文件：网络优先，离线才回缓存。保证 HTML 和 JS 永远是同一个版本。 */
  if (req.mode === 'navigate' || isFresh(req.url)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) {
            c.put(req.mode === 'navigate' ? './index.html' : req, copy);
          });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (r) {
          if (r) return r;
          if (req.mode === 'navigate') {
            return caches.match('./index.html').then(function (x) { return x || caches.match('./'); });
          }
          return Response.error();
        });
      })
    );
    return;
  }

  /* 图标之类：缓存优先 + 后台更新 */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.status === 200 && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
