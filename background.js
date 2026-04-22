// Fetches api-amis from the service worker: not subject to the page CORS policy.
// Uses session cookies (chrome.cookies) + optional Authorization from the page (sendMessage).

function buildHeadersFromCookies(cookies) {
  const h = {
    Accept: 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: 'https://amis.upcebu.edu.ph/',
    Origin:  'https://amis.upcebu.edu.ph'
  };
  const parts = [];
  for (const c of cookies) {
    parts.push(c.name + '=' + c.value);
    if (c.name === 'XSRF-TOKEN' || c.name === 'X-XSRF-TOKEN') {
      try {
        h['X-XSRF-TOKEN'] = decodeURIComponent(c.value);
      } catch (e) {
        h['X-XSRF-TOKEN'] = c.value;
      }
    }
  }
  if (parts.length) h.Cookie = parts.join('; ');
  return h;
}

async function collectRelevantCookies() {
  // Whole domain: session is often on amis, API checks it on api-amis
  const domain = 'upcebu.edu.ph';
  let all = await chrome.cookies.getAll({ domain: domain });
  if (all && all.length) return all;
  // Fallback: per-URL
  const byName = new Map();
  for (const base of ['https://api-amis.upcebu.edu.ph', 'https://amis.upcebu.edu.ph']) {
    const per = await chrome.cookies.getAll({ url: base + '/' });
    for (const c of per) {
      byName.set(c.name, c);
    }
  }
  return Array.from(byName.values());
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'GWA_API_FETCH' || !message.url) {
    return false;
  }
  (async () => {
    try {
      const cookies = await collectRelevantCookies();
      const headers = buildHeadersFromCookies(cookies);
      if (message.authorization) {
        headers.Authorization = message.authorization;
      }
      const r = await fetch(message.url, { method: 'GET', headers, redirect: 'follow' });
      const text = await r.text();
      let json;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = { _gwaNotJson: true, raw: text ? text.slice(0, 400) : '' };
      }
      sendResponse({ ok: r.ok, status: r.status, json, text });
    } catch (e) {
      sendResponse({ error: String(e) });
    }
  })();
  return true;
});
