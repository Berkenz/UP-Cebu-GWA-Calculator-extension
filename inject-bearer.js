// Runs at document_start (see manifest) so the in-page page-bearer.js can patch
// window.fetch / XHR before the AMIS app sends API requests and capture Authorization.
(function () {
  const id = 'gwa-upcebu-bearer-hook';
  function go() {
    if (document.getElementById(id)) return;
    const root = document.documentElement;
    if (!root) return;
    const s   = document.createElement('script');
    s.id      = id;
    s.src     = chrome.runtime.getURL('page-bearer.js');
    s.async   = false;
    s.defer   = false;
    root.appendChild(s);
  }
  if (document.documentElement) {
    go();
  } else {
    document.addEventListener('readystatechange', function r() {
      if (document.documentElement) {
        document.removeEventListener('readystatechange', r);
        go();
      }
    });
  }
})();
