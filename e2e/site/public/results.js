// The results panel: what SharedID Edge and Prebid.js did in this browser, on this page view, for a person looking at
// the page (the demo, https://e2e.sharedid.dev/demo/, links to every live deployment's copy of this page).
//
// It reads only what the page itself can see, and on its own sends nothing to /_sid/* under automation, so the browser
// tests, which count the page's requests, see only Prebid.js's:
//
//   - in the browser: Prebid.js's pixelUrl call (resource timing), the _pubcid cookie (document.cookie, and its expiry
//     through the Cookie Store API where the browser has it), the id Prebid.js holds and the EIDs it adds to every bid
//     request (pbjs.getUserIdsAsEids(), what goes into ortb2.user.ext.eids);
//   - from the worker: a same-origin GET of /_sid/v1, whose debugging headers (X-SharedID-Source, X-SharedID-Status)
//     and JSON (the id, the modules' output) a page can read. It runs on its own for a person (navigator.webdriver is
//     false), with ?checks=1, or from the "Ask the worker" button;
//   - the ua and bot modules' answers in that /_sid/v1 JSON: device data (ortb2.device) and the bot verdict
//     (ortb2.device.ext.traffic), each grey where the module isn't on, and encrypted-ip's eip: well formed, not shown;
//   - the HttpOnly recovery copy, on demand: "Delete _pubcid" deletes the script-readable cookie, as Safari's cap would,
//     and asks /_sid/v1 again, which should restore the same id from _pubcid_sv (X-SharedID-Source: recovery);
//   - the reflect and clickid modules, from cookies alone: uid1 (vendor-uid1.js) server-set for a year and restored
//     after "Delete uid1 and reload", and a landing page's ?gclid= kept in _sid_gclid. Their controls reload the page,
//     so Prebid.js's pixel call is still the only request.
//
// Every check is a row with data-check="<name>" and data-status="pass" | "fail" | "info" | "pending"; the summary is
// #sid-verdict with the same data-status. tests/prebid-sharedid.spec.ts reads them.
(function () {
  var params = new URLSearchParams(location.search);
  var base = location.pathname.replace(/[^/]*$/, '');
  var SID = base + '_sid';
  var DAY = 86400000;

  function readCookie(name) {
    var match = new RegExp('(?:^|;\\s*)' + name + '=([^;]*)').exec(document.cookie);
    return match ? match[1] : undefined;
  }

  // Before Prebid.js runs: whether this browser already had an id from an earlier visit.
  var before = readCookie('_pubcid');

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(child); });
    return node;
  }

  function code(text) { return el('code', { text: text }); }

  var ICONS = { pass: '\u2713', fail: '\u2717', info: '\u2013', pending: '\u2026' };

  var rows = {};
  var panel;

  // Set when the worker says this page view's consent rules the ID out: then the rows that look for a cookie the
  // worker rightly didn't set say so, rather than failing, even when they finish after the worker's answer.
  var denied;
  var CONSENT_ROWS = ['cookie', 'same-id', 'eids', 'reflect', 'clickid'];

  /** Sets a check's row: its status, title and details (strings, or nodes). */
  function report(name, status, title, details) {
    var row = rows[name];
    if (!row) return;
    if (status === 'fail' && denied !== undefined && CONSENT_ROWS.indexOf(name) >= 0) {
      status = 'info';
      title += ' (consent: ' + denied + ')';
      details = [];
    }
    row.setAttribute('data-status', status);
    row.querySelector('.sid-icon').textContent = ICONS[status];
    row.querySelector('.sid-title').textContent = title;
    var body = row.querySelector('.sid-details');
    body.textContent = '';
    (details || []).forEach(function (detail) {
      body.appendChild(typeof detail === 'string' ? document.createTextNode(detail) : detail);
    });
    verdict();
  }

  // The checks the verdict needs to pass; the others add evidence, and fail it only when they fail.
  var REQUIRED = ['prebid', 'sync', 'cookie', 'same-id', 'eids'];

  function verdict() {
    var box = document.getElementById('sid-verdict');
    if (!box) return;
    var statuses = Object.keys(rows).map(function (name) { return [name, rows[name].getAttribute('data-status')]; });
    var failed = statuses.some(function (s) { return s[1] === 'fail'; });
    var pending = statuses.some(function (s) { return s[1] === 'pending'; });
    var passed = REQUIRED.every(function (name) { return rows[name].getAttribute('data-status') === 'pass'; });
    var status = failed ? 'fail' : pending ? 'pending' : passed ? 'pass' : 'info';
    box.setAttribute('data-status', status);
    box.querySelector('.sid-icon').textContent = ICONS[status];
    box.querySelector('.sid-title').textContent = {
      pass: 'SharedID Edge is working in your browser',
      fail: 'Something isn\u2019t working: see the red checks below',
      pending: 'Checking\u2026',
      info: 'No SharedID on this page view: see below why'
    }[status];
  }

  var CHECKS = [
    ['prebid', 'Prebid.js loaded'],
    ['sync', 'Prebid.js called SharedID Edge'],
    ['cookie', 'The server set the _pubcid cookie'],
    ['same-id', 'Prebid.js uses the server\u2019s ID'],
    ['eids', 'The ID goes into every bid request'],
    ['lifetime', 'How long your browser keeps it'],
    ['worker', 'What the worker says'],
    ['recovery', 'The HttpOnly recovery copy'],
    ['modules', 'Edge modules: visitor IP and location'],
    ['id5', 'ID5 ID (server-to-server)'],
    ['reflect', 'A vendor\u2019s cookie kept by the reflect module'],
    ['clickid', 'An ad click ID kept by the clickid module'],
    ['device', 'Device data (the ua module)'],
    ['bot', 'Bot verdict (the bot and ua modules)'],
    ['eip', 'Your IP address, encrypted (the encrypted-ip module)']
  ];

  function render() {
    var style = el('style', { text: [
      '#sid-panel{font:16px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:56rem;margin:1.5rem auto;padding:0 1rem;color:#1d1d1f}',
      '#sid-panel h1{font-size:1.4rem;margin:0 0 .25rem}#sid-panel .sid-sub{color:#555;margin:0 0 1rem}',
      '#sid-panel code{font:13px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f2f2f4;padding:.05rem .3rem;border-radius:4px;word-break:break-all}',
      '#sid-panel pre{font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:#f2f2f4;padding:.5rem;border-radius:6px;overflow:auto;margin:.4rem 0 0}',
      '.sid-row,#sid-verdict{display:flex;gap:.8rem;align-items:flex-start;padding:.7rem .9rem;border-radius:10px;margin:.5rem 0;border:1px solid #ddd;background:#fafafa}',
      '.sid-icon{flex:0 0 2.2rem;height:2.2rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.4rem;font-weight:700;color:#fff;background:#999}',
      '[data-status=pass]>.sid-icon{background:#1a7f37}[data-status=fail]>.sid-icon{background:#cf222e}[data-status=info]>.sid-icon{background:#8c959f}',
      '#sid-panel [data-status=pass]{border-color:#9ad3a8;background:#f0faf2}#sid-panel [data-status=fail]{border-color:#f1a7ad;background:#fdf1f2}',
      '#sid-verdict{padding:1rem 1.1rem}#sid-verdict .sid-icon{flex-basis:3.2rem;height:3.2rem;font-size:2rem}#sid-verdict .sid-title{font-size:1.3rem}',
      '.sid-title{font-weight:600}.sid-details{color:#333;font-size:.92rem;margin-top:.15rem}',
      '#sid-panel button{font:inherit;font-size:.9rem;padding:.3rem .7rem;margin:.4rem .4rem 0 0;border-radius:6px;border:1px solid #888;background:#fff;cursor:pointer}',
      '#sid-panel .sid-foot{color:#555;font-size:.85rem;margin-top:1rem}'
    ].join('\n') });
    document.head.appendChild(style);

    var list = el('div', {}, CHECKS.map(function (check) {
      var row = el('div', { 'class': 'sid-row', 'data-check': check[0], 'data-status': 'pending' }, [
        el('div', { 'class': 'sid-icon', text: ICONS.pending }),
        el('div', {}, [el('div', { 'class': 'sid-title', text: check[1] }), el('div', { 'class': 'sid-details' })])
      ]);
      rows[check[0]] = row;
      return row;
    }));

    panel = el('div', { id: 'sid-panel' }, [
      el('h1', { text: 'SharedID Edge, live in your browser' }),
      el('p', { 'class': 'sid-sub' }, [
        document.createTextNode('This page loads unmodified Prebid.js with SharedID\u2019s '),
        code('pixelUrl'),
        document.createTextNode(' pointing at '),
        code(SID + '/sync'),
        document.createTextNode(', on the same site. Below is what happened in this browser, on this page view.')
      ]),
      el('div', { id: 'sid-verdict', 'data-status': 'pending' }, [
        el('div', { 'class': 'sid-icon', text: ICONS.pending }),
        el('div', {}, [el('div', { 'class': 'sid-title', text: 'Checking\u2026' })])
      ]),
      list,
      el('p', { 'class': 'sid-foot' }, [
        document.createTextNode('Reload the page: the ID stays. Every live deployment of SharedID Edge, and its latest test run: '),
        el('a', { href: 'https://e2e.sharedid.dev/demo/', text: 'e2e.sharedid.dev/demo' }),
        document.createTextNode('. How it works: '),
        el('a', { href: 'https://sharedid.dev/', text: 'sharedid.dev' }),
        document.createTextNode('.')
      ])
    ]);
    document.body.textContent = '';
    document.body.appendChild(panel);
  }

  /** This page view's pixelUrl call, from resource timing, once it has completed. */
  function syncEntry() {
    return performance.getEntriesByType('resource').filter(function (entry) {
      return new URL(entry.name).pathname === SID + '/sync' && entry.responseEnd > 0;
    })[0];
  }

  /** The id Prebid.js sent to pixelUrl (id=pubcid:<id>, percent-encoded once or twice). */
  function sentId(entry) {
    var raw = new URL(entry.name).searchParams.get('id');
    if (raw === null) return undefined;
    var value = decodeURIComponent(raw);
    return value.indexOf('pubcid:') === 0 ? value.slice('pubcid:'.length) : undefined;
  }

  function wait(test, ms) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var value = test();
        if (value || Date.now() - start > ms) resolve(value);
        else setTimeout(poll, 100);
      })();
    });
  }

  function days(ms) { return Math.round(ms / DAY); }

  function lifetime() {
    if (!window.cookieStore || typeof window.cookieStore.get !== 'function') {
      report('lifetime', 'info', 'How long your browser keeps it: not visible to this page', [
        'This browser doesn\u2019t expose cookie expiry to page script (the Cookie Store API' +
        (location.protocol === 'https:' ? '' : ', which needs https') + '). The server sets ',
        code('Max-Age=31536000'), ' (a year); check it in your browser\u2019s developer tools.'
      ]);
      return Promise.resolve();
    }
    return window.cookieStore.get('_pubcid').then(function (cookie) {
      if (!cookie || cookie.expires === null || cookie.expires === undefined) {
        report('lifetime', 'info', 'How long your browser keeps it: unknown', ['The browser reported no expiry for _pubcid.']);
        return;
      }
      var left = cookie.expires - Date.now();
      var where = cookie.domain ? ' on ' + cookie.domain : ' (host-only)';
      var details = ['Your browser will keep _pubcid' + where + ' until ' + new Date(cookie.expires).toLocaleDateString() +
        ': ' + days(left) + ' days. '];
      if (left > 300 * DAY) {
        details.push('Cookies written by page script are capped at 7 days in Safari; this one was set by the server, so it isn\u2019t.');
        report('lifetime', 'pass', 'Your browser keeps it for ' + days(left) + ' days', details);
      } else if (left <= 8 * DAY) {
        details.push('That\u2019s the cap browsers such as Safari put on cookies written by script, or by a server on another IP address.');
        report('lifetime', 'fail', 'Your browser caps it at ' + days(left) + ' days', details);
      } else {
        report('lifetime', 'info', 'Your browser keeps it for ' + days(left) + ' days', details);
      }
    }, function () {
      report('lifetime', 'info', 'How long your browser keeps it: not visible to this page', ['The Cookie Store API refused.']);
    });
  }

  function json(value) { return el('pre', { text: JSON.stringify(value, null, 2) }); }

  // The query Prebid.js sent to pixelUrl, without the id: its consent (gdpr, gdpr_consent, us_privacy, gpp, gpp_sid)
  // and cookie_domain. The panel's own requests carry it, so the worker decides as it did for Prebid.js's call, and
  // never sets an ID this page view's consent ruled out.
  var syncQuery = '';

  function rememberSync(entry) {
    // As sent, byte for byte: URLSearchParams would re-encode them.
    var rest = new URL(entry.name).search.slice(1).split('&').filter(function (pair) {
      return pair !== '' && pair.split('=')[0] !== 'id';
    }).join('&');
    syncQuery = rest === '' ? '' : '?' + rest;
  }

  /** GET /_sid/v1, same-origin, with the sync's consent: the worker's view, readable headers and JSON. */
  function askWorker() {
    return fetch(SID + '/v1' + syncQuery, { credentials: 'same-origin', cache: 'no-store' }).then(function (response) {
      return response.json().then(function (body) {
        return { status: response.status, source: response.headers.get('x-sharedid-source'), denied: response.headers.get('x-sharedid-status'), body: body };
      });
    });
  }

  var SOURCES = {
    cookie: 'kept the ID your browser sent in _pubcid',
    recovery: 'restored the ID from the HttpOnly recovery copy, _pubcid_sv',
    param: 'adopted the ID Prebid.js sent',
    minted: 'minted a new ID'
  };

  function workerChecks(cookieId) {
    report('worker', 'pending', 'Asking the worker\u2026', []);
    return askWorker().then(function (answer) {
      var id = answer.body.sharedid;
      var head = ['GET ', code(SID + '/v1' + syncQuery), ' answered ' + answer.status + ' with '];
      if (answer.denied) {
        report('worker', 'info', 'The worker set no ID: ' + answer.denied, head.concat([code('X-SharedID-Status: ' + answer.denied),
          ': this page view’s consent rules the ID out, so the endpoint stores none and deletes what was there.']));
        // Not failures, then: there's meant to be no ID.
        denied = answer.denied;
        CONSENT_ROWS.forEach(function (name) {
          if (rows[name].getAttribute('data-status') === 'fail') report(name, 'fail', rows[name].querySelector('.sid-title').textContent, []);
        });
      } else if (id && id === readCookie('_pubcid') && (cookieId === undefined || id === cookieId)) {
        report('worker', 'pass', 'The worker has the same ID', head.concat([
          code('X-SharedID-Source: ' + answer.source), ' (it ' + (SOURCES[answer.source] || answer.source) + ') and ',
          code('"sharedid": "' + id + '"'), ', the ID in your cookie and in Prebid.js.'
        ]));
      } else {
        report('worker', 'fail', 'The worker\u2019s ID differs', head.concat([
          code('"sharedid": "' + String(id) + '"'), ', but the cookie has ', code(String(readCookie('_pubcid'))), '.'
        ]));
      }
      modules(answer.body);
      id5(answer.body, answer.denied);
      deviceCheck(answer.body);
      botCheck(answer.body);
      encryptedIpCheck(answer.body);
      if (!answer.denied && id) recoveryReady(id);
      return answer;
    }, function (error) {
      report('worker', 'fail', 'The worker didn\u2019t answer', ['GET ' + SID + '/v1 failed: ' + String(error)]);
      report('modules', 'info', 'Edge modules: no answer', []);
      report('id5', 'info', 'ID5 ID (server-to-server): no answer', []);
      report('device', 'info', 'Device data: no answer', []);
      report('bot', 'info', 'Bot verdict: no answer', []);
      report('eip', 'info', 'Encrypted IP address: no answer', []);
    });
  }

  function modules(body) {
    var device = (body.ortb2 && body.ortb2.device) || {};
    var statuses = (body.ext && body.ext.modules) || {};
    var names = Object.keys(statuses);
    var list = names.length === 0 ? 'none' : names.map(function (name) { return name + '=' + statuses[name].status; }).join(', ');
    var ip = device.ip || device.ipv6;
    var geo = device.geo;
    var details = [];
    if (ip) details.push('Your IP address, as the edge sees it: ', code(ip), '. ');
    if (geo) {
      details.push('Your location: ', code([geo.city, geo.region, geo.country].filter(Boolean).join(', ')), '. ');
    }
    if (statuses.ip && statuses.ip.status === 'empty' && readCookie('euconsent-v2') !== undefined) {
      details.push('No IP address, and only a coarse location: this page\u2019s TC string doesn\u2019t opt in to TCF Special Feature 1 ' +
        '(precise geolocation), which the IP address needs under GDPR. ');
    }
    details.push('Modules on this deployment: ', code(list), '. The ', code('ortb2'), ' fragment the page can pass to ',
      code('pbjs.mergeConfig({ ortb2 })'), ':', json(body.ortb2 || {}));
    if (ip || geo) {
      report('modules', 'pass', 'The edge added ' + [ip ? 'your IP address' : '', geo ? 'your location' : ''].filter(Boolean).join(' and '), details);
    } else {
      report('modules', 'info', 'No IP or location modules on this deployment', details);
    }
  }

  /**
   * The id5 module's row (packages/vendor-modules/id5): grey when the deployment doesn't run it, or this page view's
   * consent rules it out; green with the ID5 EID the worker fetched server-to-server; red only when it runs, consent
   * allows it (its report's forwards), and no ID5 EID came back.
   */
  function id5(body, denied) {
    var report_ = ((body.ext && body.ext.modules) || {}).id5;
    var eid = (body.eids || []).filter(function (e) { return e.source === 'id5-sync.com'; })[0];
    if (!report_) {
      report('id5', 'info', 'ID5 ID (server-to-server): not on this deployment', ['This deployment doesn’t run the ', code('id5'), ' module.']);
    } else if (eid) {
      report('id5', 'pass', 'The edge fetched an ID5 ID', [
        'The worker asked ID5 for this visitor’s ID5 ID, server to server, and returned it in ', code(SID + '/v1'), '’s ', code('eids'),
        ' (cached in the HttpOnly ', code('sid_id5_<partner>'), ' cookie):', json(eid)
      ]);
    } else if (denied || report_.status === 'skipped' || report_.forwards === false) {
      report('id5', 'info', 'ID5 ID (server-to-server): not asked', [
        'This page view’s consent rules it out (', code(denied || report_.reason || 'forwards: false'), '), so nothing is sent to ID5.'
      ]);
    } else {
      report('id5', 'fail', 'No ID5 ID came back', [
        'The ', code('id5'), ' module runs here and consent allows it, but ', code(SID + '/v1'), ' has no ', code('id5-sync.com'),
        ' EID. Module status: ', code(report_.status), '.'
      ]);
    }
  }

  // The ua and bot modules, from the worker's /_sid/v1 answer: the device data ua reads from the User-Agent and Client
  // Hints (ortb2.device), and the traffic signal both report into (ortb2.device.ext.traffic). Green when the module
  // answered, grey when it isn't on this deployment.
  /** Whether a module ran: ok or empty, not error, timeout or skipped (not installed, or not on this route). */
  function moduleAnswered(status) { return status.status === 'ok' || status.status === 'empty'; }

  var DEVICE_TYPES = { 1: 'mobile or tablet', 2: 'computer', 3: 'connected TV', 4: 'phone', 5: 'tablet', 6: 'connected device', 7: 'set-top box' };

  function deviceCheck(body) {
    var device = (body.ortb2 && body.ortb2.device) || {};
    var statuses = (body.ext && body.ext.modules) || {};
    if (statuses.ua && !moduleAnswered(statuses.ua)) {
      report('device', statuses.ua.status === 'skipped' ? 'info' : 'fail', 'The ua module didn\u2019t answer: ' + statuses.ua.status, ['It\u2019s listed in ', code('SID_MODULES'), ' but reported ', code(statuses.ua.status), '.']);
      return;
    }
    if (!statuses.ua) {
      report('device', 'info', 'No ua module on this deployment', ['The ', code('ua'), ' module turns the browser\u2019s User-Agent and Client Hints into OpenRTB device data (',
        code('ortb2.device.sua'), ', ', code('os'), ', ', code('devicetype'), '\u2026), before any script runs. It isn\u2019t on here.']);
      return;
    }
    var fields = {};
    ['sua', 'devicetype', 'make', 'model', 'os', 'osv', 'ua'].forEach(function (key) { if (device[key] !== undefined) fields[key] = device[key]; });
    var sua = device.sua || {};
    var browser = (sua.browsers || []).filter(function (b) { return !/not.?a.?brand|chromium/i.test(b.brand); })[0] || (sua.browsers || [])[0];
    var summary = [
      browser ? browser.brand + (browser.version && browser.version[0] ? ' ' + browser.version[0] : '') : '',
      sua.platform ? 'on ' + sua.platform.brand : device.os ? 'on ' + device.os : '',
      DEVICE_TYPES[device.devicetype] ? '(' + DEVICE_TYPES[device.devicetype] + ')' : ''
    ].filter(Boolean).join(' ');
    if (Object.keys(fields).length === 0) {
      report('device', 'pass', 'The ua module answered: no device data from this browser', ['It answered ', code(statuses.ua.status), ': it reads device data from User-Agent Client Hints, which Chrome and other Chromium browsers send over https, and Firefox and Safari don\u2019t send at all. Its bot check still ran on the User-Agent (below).']);
      return;
    }
    report('device', 'pass', 'The edge read your device' + (summary === '' ? '' : ': ' + summary), [
      'The ', code('ua'), ' module read the request\u2019s User-Agent and Client Hints, before any script ran, as OpenRTB device data the page can pass to Prebid.js in ',
      code('ortb2.device'), ':', json(fields)
    ]);
  }

  function botCheck(body) {
    var device = (body.ortb2 && body.ortb2.device) || {};
    var statuses = (body.ext && body.ext.modules) || {};
    var traffic = (device.ext && device.ext.traffic) || {};
    var on = ['bot', 'ua'].filter(function (name) { return statuses[name]; });
    var failed = on.filter(function (name) { return !moduleAnswered(statuses[name]); });
    if (failed.length > 0) {
      var broken = failed.some(function (name) { return statuses[name].status !== 'skipped'; });
      report('bot', broken ? 'fail' : 'info', 'The bot verdict is incomplete', ['Listed in ', code('SID_MODULES'), ' but not answering: ',
        code(failed.map(function (name) { return name + '=' + statuses[name].status; }).join(', ')), '.']);
      return;
    }
    if (on.length === 0) {
      report('bot', 'info', 'No bot or ua module on this deployment', ['The ', code('bot'), ' and ', code('ua'), ' modules report automated traffic in ',
        code('ortb2.device.ext.traffic'), ', so the page can skip or flag the auction. They aren\u2019t on here.']);
      return;
    }
    var ja4 = [' JA4 TLS fingerprint check (the ', code('bot'), ' module\u2019s ', code('ja4Mismatch'), '): only where the platform supplies the fingerprint ',
      '(Cloudflare Bot Management, Fastly, or CloudFront configured for it), and its result shows only as a ', code('likely'), ' verdict; the fingerprint itself is never returned.'];
    var head = ['Modules on: ', code(on.join(', ')), '. ', code('ortb2.device.ext.traffic'), ': ', code(JSON.stringify(device.ext && device.ext.traffic ? traffic : {})), '.'];
    if (traffic.bot === true) {
      report('bot', 'pass', 'Flagged as a bot (' + String(traffic.botKind) + ')', head.concat([' From ', code((traffic.sources || []).join(', ')),
        '. With ', code('SID_SKIP_BOTS'), ', the worker mints no SharedID for such requests (', code('X-SharedID-Status: skipped: bot'), ').'], ja4));
    } else {
      report('bot', 'pass', 'Not flagged as a bot', head.concat([' Your browser sent what browsers send, and its User-Agent names no crawler.'], ja4));
    }
  }

  // The opt-in encrypted-ip module, from the worker's /_sid/v1 answer: the client's address encrypted to each recipient's
  // public key, in the payload's eip (never in ortb2). The row checks each value is well formed (unpadded base64url,
  // 67 to 124 characters, with a kid) and doesn't show it: only the recipient's private key can read it.
  function encryptedIpCheck(body) {
    var statuses = (body.ext && body.ext.modules) || {};
    var status = statuses['encrypted-ip'];
    var about = ['The ', code('encrypted-ip'), ' module encrypts your IP address to the public key of each recipient (Google Publisher Tag, or a Prebid Server host), ',
      'so the page can pass it on without any script being able to read it. '];
    if (!status) {
      report('eip', 'info', 'No encrypted-ip module on this deployment', about.concat(['It\u2019s opt-in at build time, and isn\u2019t on here.']));
      return;
    }
    var eip = body.eip || {};
    var values = [];
    if (eip.google) values.push(['Google', eip.google]);
    Object.keys(eip.pbs || {}).forEach(function (host) { values.push([host, eip.pbs[host]]); });
    if (values.length === 0) {
      var why = status.status === 'error' ? 'its settings are invalid.'
        : status.stale ? 'no recipient has a usable key.'
          : readCookie('euconsent-v2') !== undefined ? 'this page\u2019s TC string doesn\u2019t opt in to TCF Special Feature 1 (precise geolocation), which the IP address needs under GDPR, as for the plain address.'
            : 'consent rules it out, or the platform gave no client address.';
      report('eip', status.status === 'error' ? 'fail' : 'info', 'No encrypted IP address on this page view', about.concat(['It answered ', code(status.status), ': ', why]));
      return;
    }
    var wellFormed = values.every(function (entry) {
      return typeof entry[1].value === 'string' && /^[A-Za-z0-9_-]{67,124}$/.test(entry[1].value) && typeof entry[1].kid === 'string' && entry[1].kid !== '';
    });
    var list = values.map(function (entry) {
      return entry[0] + ' (key ' + String(entry[1].kid) + ', ' + String(entry[1].value).length + ' characters' + (entry[1].stale ? ', stale key' : '') + ')';
    }).join('; ');
    report('eip', wellFormed ? 'pass' : 'fail', wellFormed ? 'The edge encrypted your IP address for ' + values.length + (values.length === 1 ? ' recipient' : ' recipients') : 'A malformed encrypted IP address',
      about.concat([code('eip'), ': ', list, '. ', wellFormed
        ? 'Each is a fresh encryption, different on every request, and only that recipient\u2019s private key can read it, so it isn\u2019t shown here.'
        : 'A value should be unpadded base64url of 67 to 124 characters, with the kid of the key it was encrypted to.']));
  }

  var recoveryId;

  function recoveryReady(id) {
    recoveryId = id;
    var button = el('button', { type: 'button', id: 'sid-recover', text: 'Delete _pubcid, as Safari\u2019s cap would, and ask again' });
    button.addEventListener('click', recover);
    report('recovery', 'info', 'The HttpOnly recovery copy: try it', [
      'The server also set ', code('_pubcid_sv'), ', an HttpOnly copy page script can\u2019t read (',
      code('document.cookie'), ' has ' + (readCookie('_pubcid_sv') === undefined ? 'no' : 'a') + ' _pubcid_sv). If the ',
      code('_pubcid'), ' cookie is lost, the worker restores it from that copy. ', el('br'), button
    ]);
  }

  /** Deletes a cookie on every domain it can be on, as Safari's cap or a cookie cleaner would. */
  function deleteCookie(name) {
    var secure = location.protocol === 'https:' ? '; Secure' : '';
    var labels = location.hostname.split('.');
    document.cookie = name + '=; Path=/; Max-Age=0; SameSite=Lax' + secure;
    for (var i = 0; i < labels.length - 1; i++) {
      document.cookie = name + '=; Path=/; Domain=' + labels.slice(i).join('.') + '; Max-Age=0; SameSite=Lax' + secure;
    }
  }

  function recover() {
    var id = recoveryId;
    deleteCookie('_pubcid');
    var gone = readCookie('_pubcid') === undefined;
    report('recovery', 'pending', 'Deleted _pubcid; asking the worker\u2026', []);
    return askWorker().then(function (answer) {
      // The response's Set-Cookie can reach document.cookie a moment after the fetch resolves (WebKit).
      return wait(function () { return readCookie('_pubcid'); }, 2000).then(function () { return answer; });
    }).then(function (answer) {
      var back = readCookie('_pubcid');
      if (gone && answer.source === 'recovery' && answer.body.sharedid === id && back === id) {
        report('recovery', 'pass', 'Restored from the HttpOnly copy', [
          'With ', code('_pubcid'), ' deleted, ', code(SID + '/v1'), ' answered ', code('X-SharedID-Source: recovery'),
          ' and set ', code('_pubcid=' + id), ' again: the same ID.'
        ]);
      } else {
        report('recovery', 'fail', 'Not restored', [
          (gone ? '' : 'Page script couldn\u2019t delete _pubcid. ') + 'The worker answered ',
          code('X-SharedID-Source: ' + String(answer.source)), ' with ', code(String(answer.body.sharedid)),
          '; the cookie is now ', code(String(back)), ', and was ', code(String(id)), '.'
        ]);
      }
    }, function (error) {
      report('recovery', 'fail', 'The worker didn\u2019t answer', [String(error)]);
    });
  }

  // The reflect and clickid modules, which every live deployment runs on Prebid.js's pixel call. Neither check sends
  // anything to /_sid/*: their buttons reload the page, and Prebid.js's own /_sid/sync call does the work.

  /** A cookie as the Cookie Store API reports it (null when absent), or undefined where page script can't see it. */
  function storedCookie(name) {
    if (!window.cookieStore || typeof window.cookieStore.get !== 'function') return Promise.resolve(undefined);
    return window.cookieStore.get(name).then(function (cookie) { return cookie || null; }, function () { return undefined; });
  }

  /** How long a cookie has left, in days, or undefined where the browser doesn't say. */
  function daysLeft(cookie) {
    return cookie && typeof cookie.expires === 'number' ? days(cookie.expires - Date.now()) : undefined;
  }

  /** This page's path and query, with some query parameters changed (null removes one). */
  function withParams(changes) {
    var next = new URLSearchParams(location.search);
    Object.keys(changes).forEach(function (key) {
      if (changes[key] === null) next.delete(key);
      else next.set(key, changes[key]);
    });
    var query = next.toString();
    return location.pathname + (query === '' ? '' : '?' + query);
  }

  // reflect: vendor-uid1.js, a stand-in ID vendor's tag, writes uid1 from page script (7 days at most in Safari); the
  // worker sets it again on Prebid.js's pixel call, for a year, with an HttpOnly backup (_sid_keep). "Delete uid1 and
  // reload" deletes it and reloads with ?vendor=late, so the vendor tag runs after the pixel call and can't re-mint it
  // first, and with ?uid1was=<value>, the value the worker should restore from the backup.
  function reflectCheck() {
    var was = params.get('uid1was');
    var vendor = params.get('vendor');
    var expected = was === null ? undefined : encodeURIComponent(was);
    var restore = button('Delete uid1 and reload', function () {
      var value = readCookie('uid1');
      deleteCookie('uid1');
      location.assign(withParams({ vendor: 'late', uid1was: value === undefined ? null : decodeURIComponent(value) }));
    });
    restore.id = 'sid-uid1-delete';
    return wait(function () { return expected === undefined || readCookie('uid1') === expected; }, 2000).then(function () {
      return storedCookie('uid1');
    }).then(function (cookie) {
      var value = readCookie('uid1');
      var left = daysLeft(cookie);
      var about = ['A stand-in ID vendor tag (', code('vendor-uid1.js'), ') writes ', code('uid1'),
        ' from page script, which Safari keeps for 7 days at most. The worker sets it again on Prebid.js\u2019s ',
        code(SID + '/sync'), ' call, for a year, with an HttpOnly backup. '];
      var kept = left === undefined
        ? ['This browser doesn\u2019t show cookie expiry to page script (the Cookie Store API' +
          (location.protocol === 'https:' ? '' : ', which needs https') + '); the worker sets it with ', code('Max-Age=31536000'), '. ']
        : ['Your browser will keep it for ' + left + ' days. '];
      var now = ['Now: ', code('uid1=' + String(value)), '. '];
      if (value === undefined) {
        report('reflect', was === null ? 'info' : 'fail', was === null ? 'No uid1 on this page view' : 'uid1 wasn\u2019t restored',
          about.concat(vendor === 'none' ? ['This page view leaves the vendor tag out (', code('?vendor=none'), ').'] : [el('br'), restore]));
      } else if (was !== null) {
        var same = value === expected;
        report('reflect', same ? 'pass' : 'fail', same ? 'The worker restored uid1, with the same value' : 'uid1 wasn\u2019t restored', about.concat([
          'You deleted ', code('uid1=' + String(expected)), ' and reloaded. ', same
            ? 'Prebid.js\u2019s pixel call brought it back from the backup, before the vendor tag ran. '
            : 'The worker didn\u2019t restore it. '
        ], now, kept, [el('br'), restore]));
      } else if (left !== undefined && left > 300) {
        report('reflect', 'pass', 'The server keeps uid1 for ' + left + ' days', about.concat(now, kept, [el('br'), restore]));
      } else if (left !== undefined && left <= 8 && vendor === null) {
        report('reflect', 'fail', 'uid1 is capped at ' + left + ' days', about.concat(now, kept, ['The worker didn\u2019t set it again.']));
      } else {
        report('reflect', 'info', 'uid1 is here: delete it to see it restored', about.concat(now, kept, [el('br'), restore]));
      }
    });
  }

  // clickid: a landing page's ?gclid=, read from the pixel call's Referer, kept in a server-set _sid_gclid
  // (<seconds>.<gclid>) for 90 days. The "try it" link reloads the page with a made-up click ID.
  function clickidCheck() {
    var gclid = params.get('gclid');
    var tryIt = el('a', {
      id: 'sid-gclid-try',
      href: withParams({ gclid: 'demo-' + Math.random().toString(36).slice(2, 10), uid1was: null }),
      text: 'Try it: reload this page as an ad click\u2019s landing page, with ?gclid=demo-\u2026'
    });
    function clickId(value) { return value === undefined ? undefined : decodeURIComponent(value).replace(/^[0-9]+\./, ''); }
    return wait(function () { return gclid === null || clickId(readCookie('_sid_gclid')) === gclid; }, 2000).then(function () {
      return storedCookie('_sid_gclid');
    }).then(function (cookie) {
      var value = readCookie('_sid_gclid');
      var left = daysLeft(cookie);
      var about = ['An ad click lands on a page with a click ID in its URL (', code('gclid'), ', ', code('fbclid'), ', ', code('msclkid'),
        '\u2026). The worker reads it from the ', code('Referer'), ' of Prebid.js\u2019s pixel call and keeps it in ',
        code('_sid_gclid'), ', a server-set cookie page script can read, for 90 days from the click' +
        (left === undefined ? '' : ' (' + left + ' days left)') + '. '];
      if (gclid !== null) {
        var ok = clickId(value) === gclid;
        report('clickid', ok ? 'pass' : 'fail', ok ? 'The server kept this page\u2019s click ID' : 'The click ID wasn\u2019t kept', about.concat([
          'This page view\u2019s URL has ', code('gclid=' + gclid), '; the cookie: ', code('_sid_gclid=' + String(value)), '.'
        ]));
      } else if (value !== undefined) {
        report('clickid', 'info', 'A click ID from an earlier landing page', about.concat([code('_sid_gclid=' + value), '. ', el('br'), tryIt]));
      } else {
        report('clickid', 'info', 'No ad click ID on this page view: try it', about.concat([el('br'), tryIt]));
      }
    });
  }

  function run() {
    render();
    var pbjs = window.pbjs;
    if (!pbjs || typeof pbjs.getUserIds !== 'function') {
      report('prebid', 'fail', 'Prebid.js didn\u2019t load', ['prebid/prebid.js is missing or failed.']);
    } else {
      var hasShared = (pbjs.installedModules || []).indexOf('sharedIdSystem') >= 0;
      report('prebid', hasShared ? 'pass' : 'fail', 'Prebid.js ' + pbjs.version + (hasShared ? ' loaded, with sharedIdSystem' : ' has no sharedIdSystem'), [
        'Unmodified Prebid.js, configured with ', code("userIds: [{ name: 'sharedId', params: { pixelUrl: '" + SID + "/sync', extend: true } }]"), '.'
      ]);
    }

    var automated = navigator.webdriver === true && params.get('checks') !== '1';

    wait(syncEntry, 15000).then(function (entry) {
      if (!entry) {
        var optedOut = readCookie('_pubcid_optout') !== undefined;
        var consent = params.get('consent');
        var why = optedOut ? 'You opted out (_pubcid_optout), so Prebid.js stores no ID.'
          : consent === 'denied' ? 'This page view denies consent (?consent=denied), so Prebid.js stores no ID.' : '';
        report('sync', why ? 'info' : 'fail', 'Prebid.js didn\u2019t call ' + SID + '/sync', [why || 'No pixelUrl request within 15 seconds.']);
        ['cookie', 'same-id', 'eids', 'lifetime', 'worker', 'recovery', 'modules', 'id5', 'reflect', 'clickid', 'device', 'bot', 'eip'].forEach(function (name) {
          report(name, 'info', rows[name].querySelector('.sid-title').textContent.replace(/[:\u2026]+$/, '') + ': not checked', []);
        });
        return undefined;
      }
      var sent = sentId(entry);
      rememberSync(entry);
      // responseStatus (Chrome, Firefox): a failed sync fails the check, even when an earlier visit's cookie makes the
      // others pass. Where the browser doesn't report it (Safari), the cookie checks below are the evidence.
      var code_ = typeof entry.responseStatus === 'number' && entry.responseStatus > 0 ? entry.responseStatus : undefined;
      var ok = code_ === undefined || (code_ >= 200 && code_ < 300);
      report('sync', ok ? 'pass' : 'fail', ok ? 'Prebid.js called SharedID Edge' : 'SharedID Edge answered Prebid.js with ' + code_, [
        'GET ', code(new URL(entry.name).pathname + new URL(entry.name).search),
        (code_ === undefined ? ' answered' : ' answered ' + code_) + ' in ' + Math.round(entry.responseEnd - entry.startTime) + ' ms.' +
          (ok ? '' : ' The ID cookies below may be left from an earlier visit; this sync didn’t refresh them.')
      ]);
      // The pixel's Set-Cookie shows in document.cookie by the next task; Prebid.js reads it in the pixel's load handler.
      return wait(function () { return pbjs.getUserIds().pubcid && readCookie('_pubcid'); }, 3000).then(function () { return sent; });
    }).then(function (sent) {
      if (sent === undefined && !syncEntry()) return undefined;
      var cookieId = readCookie('_pubcid');
      var prebidId = pbjs.getUserIds().pubcid;
      if (cookieId === undefined) {
        report('cookie', 'fail', 'No _pubcid cookie', ['The sync set no _pubcid this page can read.']);
      } else {
        report('cookie', 'pass', 'The server set the _pubcid cookie', before === undefined
          ? ['First visit: Prebid.js minted ', code(String(sent)), ' and sent it to the endpoint, which set it as a first-party cookie: ', code('_pubcid=' + cookieId), '.']
          : before === cookieId
            ? ['Returning visit: your browser sent ', code('_pubcid=' + cookieId), ' and the endpoint kept it, and set it again for another year.']
            : ['Your browser had ', code('_pubcid=' + before), ' and now has ', code('_pubcid=' + cookieId), '.']);
      }
      report('same-id', cookieId !== undefined && prebidId === cookieId ? 'pass' : 'fail',
        prebidId === cookieId ? 'Prebid.js uses the server\u2019s ID' : 'Prebid.js has a different ID', [
          code('pbjs.getUserIds().pubcid'), ' is ', code(String(prebidId)), prebidId === cookieId ? ', the cookie\u2019s value.' : ', the cookie ' + String(cookieId) + '.'
        ]);
      var eids = typeof pbjs.getUserIdsAsEids === 'function' ? pbjs.getUserIdsAsEids() : [];
      var pubcid = eids.filter(function (eid) { return eid.source === 'pubcid.org'; })[0];
      var eidId = pubcid && pubcid.uids && pubcid.uids[0] && pubcid.uids[0].id;
      report('eids', eidId !== undefined && eidId === cookieId ? 'pass' : 'fail', eidId === cookieId ? 'The ID goes into every bid request' : 'The ID isn\u2019t in the bid request EIDs', [
        'Prebid.js adds these EIDs to every bid request, as ', code('ortb2.user.ext.eids'), ' (', code('pbjs.getUserIdsAsEids()'), '):', json(eids)
      ]);
      var checks = [lifetime(), reflectCheck(), clickidCheck()];
      if (automated) {
        report('worker', 'info', 'What the worker says: not asked', [
          'Under automation the page sends nothing of its own to the endpoint. ', button('Ask the worker', function () { void workerChecks(cookieId); })
        ]);
        report('recovery', 'info', 'The HttpOnly recovery copy: ask the worker first', []);
        report('modules', 'info', 'Edge modules: ask the worker first', []);
        report('id5', 'info', 'ID5 ID (server-to-server): ask the worker first', []);
        report('device', 'info', 'Device data: ask the worker first', []);
        report('bot', 'info', 'Bot verdict: ask the worker first', []);
        report('eip', 'info', 'Encrypted IP address: ask the worker first', []);
      } else {
        checks.push(workerChecks(cookieId));
      }
      return Promise.all(checks);
    });
  }

  function button(text, onClick) {
    var node = el('button', { type: 'button', text: text });
    node.addEventListener('click', onClick);
    return node;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})();
