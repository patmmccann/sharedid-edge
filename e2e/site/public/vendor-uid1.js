// A stand-in for an ID vendor's tag, for the reflect module's uid1 walkthrough (packages/modules/reflect/README.md):
// it writes uid1 from page script, as vendors' tags do, on the site's registrable domain, with the 7-day lifetime
// Safari gives script cookies. It keeps an existing uid1 and mints one otherwise.
//
// The page loads it before Prebid.js, so by default it writes uid1 before Prebid.js's pixelUrl call. ?vendor=late runs
// it 1.5 s later instead, after that call; ?vendor=none leaves it out.
(function () {
  var mode = new URLSearchParams(location.search).get('vendor') || 'early';
  if (mode === 'none') return;
  function write() {
    if (/(?:^|;\s*)uid1=/.test(document.cookie)) return;
    var id = 'v1.' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    var domain = location.hostname.split('.').slice(-2).join('.');
    document.cookie = 'uid1=' + id + '; Path=/; Domain=' + domain + '; Max-Age=' + 7 * 86400 + '; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  }
  if (mode === 'late') setTimeout(write, 1500);
  else write();
})();
