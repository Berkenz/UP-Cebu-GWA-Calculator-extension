/**
 * Page context only — reads localStorage/sessionStorage for a Bearer token.
 * No fetch() here (avoids CORS on api-amis). The extension background does fetch.
 *
 * AMIS uses Laravel Sanctum: token shape like "123|...plain..." and may live under
 * Nuxt/Pinia key names, not only "token" / "access_token".
 */
(function () {
  if (window.__gwaUpCebuBearerHook) return;
  window.__gwaUpCebuBearerHook = true;

  if (!window.__gwaLastBearer) window.__gwaLastBearer = null;
  if (!window.__gwaFetchPatched) {
    window.__gwaFetchPatched = true;
    const of = window.fetch;
    window.fetch = function () {
      const r = of.apply(this, arguments);
      try {
        const o = arguments[1];
        if (o && o.headers) {
          const h = o.headers;
          const a = typeof h.get === 'function' ? h.get('Authorization') || h.get('authorization') : h.Authorization || h.authorization;
          if (a && /Bearer\s+/i.test(String(a))) window.__gwaLastBearer = String(a);
        }
      } catch (e) { /* ignore */ }
      return r;
    };
  }
  if (!window.__gwaXhrPatched) {
    window.__gwaXhrPatched = true;
    const osh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (k && /^authorization$/i.test(k) && v && /Bearer/i.test(String(v))) {
        window.__gwaLastBearer = String(v);
      }
      return osh.apply(this, arguments);
    };
  }

  function looksLikeBearerValue(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 20) return false;
    if (/^Bearer\s+/i.test(t)) return true;
    if (/^eyJ[A-Za-z0-9_-]*\.eyJ/.test(t)) return true;
    if (/^\d{2,20}\|[A-Za-z0-9+/=]+$/i.test(t)) return true; // Sanctum id|secret
    if (/^[\w\-+/=]{40,200}$/.test(t) && t.length < 500) return true;
    return false;
  }

  function stripPrefix(v) {
    return String(v)
      .trim()
      .replace(/^Bearer\s+/i, '');
  }

  function tryParseJson(v) {
    if (!v) return null;
    const t = v.trim();
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return null;
    try {
      return JSON.parse(v);
    } catch (e) {
      return null;
    }
  }

  function findTokenInObject(obj, depth) {
    if (obj == null || depth > 10) return null;
    if (typeof obj === 'string' && looksLikeBearerValue(obj)) return stripPrefix(obj);
    if (typeof obj !== 'object') return null;
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        const t = findTokenInObject(obj[i], depth + 1);
        if (t) return t;
      }
      return null;
    }
    const keyHint = /auth|token|bearer|session|user|api_key|access|sanctum|laravel|plain|credential|abilities|name/i;
    for (const key of Object.keys(obj)) {
      if (!keyHint.test(key)) continue;
      const v = obj[key];
      if (typeof v === 'string' && looksLikeBearerValue(v)) return stripPrefix(v);
      const t = findTokenInObject(v, depth + 1);
      if (t) return t;
    }
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (v != null && typeof v === 'object') {
        const t = findTokenInObject(v, depth + 1);
        if (t) return t;
      }
    }
    return null;
  }

  function scanStorage(storage) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key) continue;
        const v = storage.getItem(key);
        if (!v) continue;
        if (looksLikeBearerValue(v) && v.trim().charAt(0) !== '{' && v.trim().charAt(0) !== '[') {
          return stripPrefix(v);
        }
        const p = tryParseJson(v);
        if (p) {
          const t = findTokenInObject(p, 0);
          if (t) return t;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function pickBearer() {
    if (window.__gwaLastBearer) return window.__gwaLastBearer;
    try {
      const directKeys = [
        'access_token',
        'token',
        'auth_token',
        'bearer',
        'bearerToken',
        'api_token',
        'user_token',
        'accessToken',
        'auth',
        'sanctum',
        'laravel_sanctum'
      ];
      for (let k = 0; k < directKeys.length; k++) {
        const key = directKeys[k];
        const v = localStorage.getItem(key) || sessionStorage.getItem(key);
        if (!v) continue;
        if (v.trim().charAt(0) === '{' || v.trim().charAt(0) === '[') {
          const p = tryParseJson(v);
          if (p) {
            const t = findTokenInObject(p, 0);
            if (t) return 'Bearer ' + t;
          }
        } else if (looksLikeBearerValue(v)) {
          return 'Bearer ' + stripPrefix(v);
        }
      }
      const t1 = scanStorage(localStorage);
      if (t1) return 'Bearer ' + t1;
      const t2 = scanStorage(sessionStorage);
      if (t2) return 'Bearer ' + t2;
    } catch (e) { /* ignore */ }
    return null;
  }

  window.addEventListener('message', function (e) {
    if (e.origin !== window.location.origin) return;
    if (e.data && e.data.gwaType === 'GWA_GET_BEARER' && e.data.gwaBearerId != null) {
      window.postMessage(
        {
          gwaType: 'GWA_BEARER',
          gwaBearerId: e.data.gwaBearerId,
          bearerValue: pickBearer()
        },
        '*'
      );
    }
  });
  try {
    const sc = document.getElementById('gwa-upcebu-bearer-hook');
    if (sc) sc.setAttribute('data-gwa-ready', '1');
  } catch (e) { /* ignore */ }
})();
