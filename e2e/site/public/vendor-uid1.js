// A stand-in for an ID vendor's tag, for the reflect module's uid1 walkthrough (packages/modules/reflect/README.md):
// it writes uid1 from page script, as vendors' tags do, on the highest domain it can (the site's registrable domain,
// or the whole hostname under a public suffix such as cloudfront.net), with the 7-day lifetime
// Safari gives script cookies. It keeps an existing uid1 and mints one otherwise.
//
// The page loads it before Prebid.js, so by default it writes uid1 before Prebid.js's pixelUrl call. ?vendor=late runs
// it 1.5 s later instead, after that call; ?vendor=none leaves it out.
(function () {
  var mode = new URLSearchParams(location.search).get('vendor') || 'early';
  if (mode === 'none') return;
  // The highest domain that takes a cookie, found as Prebid.js finds it, by writing a test cookie: sharedid.dev for
  // e2e.sharedid.dev, but d111111abcdef8.cloudfront.net itself, since browsers refuse cookies on a public suffix.
  function topDomain() {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    var labels = location.hostname.split('.');
    for (var i = Math.max(labels.length - 2, 0); i > 0; i--) {
      var candidate = labels.slice(i).join('.');
      document.cookie = '_uid1_probe=1; Path=/; Domain=' + candidate + '; SameSite=Lax' + secure;
      var ok = /(?:^|;\s*)_uid1_probe=1/.test(document.cookie);
      document.cookie = '_uid1_probe=; Path=/; Domain=' + candidate + '; Max-Age=0; SameSite=Lax' + secure;
      if (ok) return candidate;
    }
    return location.hostname;
  }
  function write() {
    if (/(?:^|;\s*)uid1=/.test(document.cookie)) return;
    var id = 'v1.' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    var domain = topDomain();
    document.cookie = 'uid1=' + id + '; Path=/; Domain=' + domain + '; Max-Age=' + 7 * 86400 + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }
  if (mode === 'late') setTimeout(write, 1500);
  else write();
})();
