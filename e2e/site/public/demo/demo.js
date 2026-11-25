// The live demo's tiles (demo/index.html): one per live deployment the live-test workflows keep running, and one per
// check that runs only on a CI machine. Each shows the latest completed run of its workflow on main, from GitHub's
// public API (unauthenticated: 60 requests an hour per address, so results are cached in localStorage for ten
// minutes; each tile says when it last asked, with a link that asks again), narrowed to the tile's own jobs when a
// workflow tests several deployments.
(function () {
  var REPO = 'patmmccann/sharedid-edge';
  var API = 'https://api.github.com/repos/' + REPO + '/actions';
  var CACHE_MS = 10 * 60 * 1000;

  // site: the deployment's e2e page, with the results panel. jobs: the workflow's jobs that test this deployment (all
  // when absent). embed: same site as e2e.sharedid.dev, so it can run in a frame here with its first-party cookie.
  var LIVE = [
    {
      name: 'Cloudflare Worker',
      shape: 'A Worker on the site\u2019s own route, e2e.sharedid.dev/_sid/*, beside the static site on the same hostname.',
      site: 'https://e2e.sharedid.dev/',
      workflow: 'e2e-cloudflare.yml',
      // Not the /platform jobs, the tile below.
      jobs: /^(?!.*\/platform)/,
      embed: true
    },
    {
      name: 'Cloudflare Worker, with the IP and location modules',
      shape: 'A second Worker, on e2e.sharedid.dev/platform/_sid/*, with the ip and geo modules reading Cloudflare\u2019s request data, beside a copy of the page at /platform/.',
      site: 'https://e2e.sharedid.dev/platform/',
      workflow: 'e2e-cloudflare.yml',
      jobs: /^Deploy to sharedid\.dev|\/platform/,
      embed: true
    },
    {
      name: 'AWS CloudFront + Lambda',
      shape: 'A Lambda function behind a /_sid/* behaviour of the site\u2019s CloudFront distribution (the page from S3).',
      site: 'https://da614puh352or.cloudfront.net/',
      workflow: 'e2e-aws.yml',
      // The CloudFront jobs and the EU visitor of this distribution, not the Lambda@Edge ones.
      jobs: /CloudFront|^An EU visitor \(eu-central-1\)$/
    },
    {
      name: 'AWS CloudFront + Lambda, with the IP and location modules',
      shape: 'A second function behind the same distribution\u2019s /platform/_sid/* behaviour, with the ip, geo, ua and bot modules reading CloudFront\u2019s viewer headers, beside a copy of the page at /platform/.',
      site: 'https://da614puh352or.cloudfront.net/platform/',
      workflow: 'e2e-aws.yml',
      // The deploy (which deploys this function too), the /platform browser tests, and the EU visitor, which requests
      // /platform/_sid.
      jobs: /^Deploy to CloudFront|\/platform|^An EU visitor \(eu-central-1\)$/
    },
    {
      name: 'Vercel',
      shape: 'The Next.js example\u2019s /_sid/* route handler on a Node.js function, beside the page, on vercel.app.',
      site: 'https://sharedid-e2e.vercel.app/',
      workflow: 'e2e-vercel.yml'
    },
    {
      name: 'Upstream operator behind a Cloudflare publisher',
      shape: 'The publisher\u2019s Cloudflare zone forwards /_sid/* to an upstream operator\u2019s endpoint (trusted-upstream mode, on its own domain); the cookie is still the publisher\u2019s.',
      site: 'https://saleshouse-pub.sharedid.dev/',
      // Shown instead of the test hostname.
      label: 'the test publisher, on a sharedid.dev subdomain',
      workflow: 'e2e-upstream.yml',
      // Its own jobs, and the EU visitor, which requests all three of this workflow's sites.
      jobs: /Deploy the Workers|saleshouse-pub\.sharedid\.dev|^An EU visitor/,
      embed: true
    },
    {
      name: 'Upstream operator behind a CloudFront publisher',
      shape: 'The publisher\u2019s CloudFront distribution forwards /_sid/* to the same upstream operator\u2019s endpoint.',
      site: 'https://pub.hotba.be/',
      workflow: 'e2e-upstream.yml',
      jobs: /CloudFront publisher|pub\.hotba\.be|^An EU visitor/
    },
    {
      name: 'Hosting company on Cloudflare for SaaS',
      shape: 'A customer\u2019s custom hostname on a Cloudflare for SaaS zone, with SharedID Edge for the hostnames it lists.',
      site: 'https://saas.hotba.be/',
      workflow: 'e2e-upstream.yml',
      jobs: /Deploy the Workers|saas\.hotba\.be|^An EU visitor/
    },
    {
      name: 'Node.js container on AWS Lambda behind a Cloudflare publisher',
      shape: 'The Node.js server\u2019s container image as an upstream endpoint on AWS Lambda; a Cloudflare publisher forwards e2e.sharedid.dev/node-upstream/_sid/* to it.',
      site: 'https://e2e.sharedid.dev/node-upstream/',
      workflow: 'e2e-node-upstream.yml',
      embed: true
    }
  ];

  var CI = [
    {
      name: 'Server-side GTM',
      shape: 'SharedID Edge beside Google\u2019s real server-side Tag Manager image and the SharedID variable template, in docker compose on the runner.',
      workflow: 'e2e-sgtm.yml',
      jobs: /sGTM, on Google/
    },
    {
      name: 'Real Safari (macOS)',
      shape: 'The core browser tests in real Safari through safaridriver, on a macOS runner, against a local server: server-set cookies, restore, consent.',
      workflow: 'ci.yml',
      jobs: /real Safari/
    }
  ];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }

  var ICONS = { pass: '\u2713', fail: '\u2717', info: '\u2013', pending: '\u2026' };

  // A cached answer, { at, body }, while it's fresh.
  function cached(url) {
    try {
      var hit = JSON.parse(localStorage.getItem('sid-demo:' + url) || 'null');
      if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    } catch (e) { /* no storage */ }
    return undefined;
  }

  function store(url, body) {
    try { localStorage.setItem('sid-demo:' + url, JSON.stringify({ at: Date.now(), body: body })); } catch (e) { /* no storage */ }
  }

  // The workflows' bookkeeping jobs ("Which parts are set up", "Report the run"), which pass even when the tests are
  // skipped: never part of a tile's result.
  var BOOKKEEPING = /set up|Report the run/;

  var inflight = {};

  /**
   * GET a GitHub API URL, from the cache unless `fresh`; resolves to { at, body }, `at` being when GitHub answered.
   * Rejects with a readable message, naming the rate limit's reset when it's used up.
   */
  function github(url, fresh) {
    var hit = fresh ? undefined : cached(url);
    if (hit !== undefined) return Promise.resolve(hit);
    if (inflight[url]) return inflight[url];
    inflight[url] = fetch(url, { headers: { Accept: 'application/vnd.github+json' }, cache: fresh ? 'no-store' : 'default' }).then(function (response) {
      delete inflight[url];
      if (response.ok) return response.json().then(function (body) { store(url, body); return { at: Date.now(), body: body }; });
      var reset = Number(response.headers.get('x-ratelimit-reset'));
      if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error('GitHub\u2019s API limit for your address is used up' + (reset ? ' until ' + new Date(reset * 1000).toLocaleTimeString() : '') + '.');
      }
      throw new Error('GitHub\u2019s API answered ' + response.status + '.');
    }, function (error) { delete inflight[url]; throw error; });
    return inflight[url];
  }

  /** "3 min ago" for an ISO date or a millisecond time. */
  function ago(when) {
    var minutes = Math.round((Date.now() - (typeof when === 'number' ? when : Date.parse(when))) / 60000);
    if (minutes < 60) return minutes + ' min ago';
    var hours = Math.round(minutes / 60);
    return hours < 48 ? hours + ' h ago' : Math.round(hours / 24) + ' days ago';
  }

  function jobStatus(job) {
    if (job.conclusion === 'success') return 'pass';
    if (job.conclusion === 'skipped' || job.conclusion === 'neutral' || job.conclusion === null) return 'info';
    return 'fail';
  }

  // A browser job's chip: "chromium" from "Prebid.js end to end, pub.hotba.be (chromium)".
  function browser(job) {
    var match = /\((chromium|firefox|webkit|Chromium|real Safari, macOS)\)$/.exec(job.name);
    return match ? match[1].replace('real Safari, macOS', 'Safari').toLowerCase() : undefined;
  }

  function runsPage(tile) {
    return 'https://github.com/' + REPO + '/actions/workflows/' + tile.workflow + '?query=branch%3Amain';
  }

  // "Checked 3 min ago · Check again": when GitHub was last asked, and a link that asks again, skipping the cache.
  function checked(tile, node, at) {
    var again = el('a', { href: '#', text: 'Check again' });
    again.addEventListener('click', function (event) {
      event.preventDefault();
      node.querySelector('.run').textContent = 'Checking GitHub again…';
      load(tile, node, true);
    });
    return el('div', { 'class': 'checked' }, ['Checked ' + (Date.now() - at < 60000 ? 'just now' : ago(at)) + ' · ', again]);
  }

  function load(tile, node, fresh) {
    var status = node.querySelector('.run');
    var at;
    github(API + '/workflows/' + tile.workflow + '/runs?branch=main&status=completed&exclude_pull_requests=true&per_page=1', fresh).then(function (answer) {
      at = answer.at;
      var run = answer.body.workflow_runs && answer.body.workflow_runs[0];
      if (!run) throw new Error('No completed run on main yet.');
      return github(API + '/runs/' + run.id + '/jobs?per_page=100', fresh).then(function (jobs) { return [run, jobs.body.jobs || []]; });
    }).then(function (result) {
      var run = result[0];
      var jobs = result[1].filter(function (job) { return !BOOKKEEPING.test(job.name) && (!tile.jobs || tile.jobs.test(job.name)); });
      var statuses = jobs.map(jobStatus);
      var state = statuses.indexOf('fail') >= 0 ? 'fail' : statuses.indexOf('pass') >= 0 ? 'pass' : 'info';
      node.setAttribute('data-status', state);
      node.querySelector('.icon').textContent = ICONS[state];
      var words = { pass: 'Passed', fail: 'Failed', info: 'Didn\u2019t run (skipped: not set up, or an earlier job failed)' }[state];
      status.textContent = '';
      status.appendChild(el('span', {}, [
        el('strong', { text: words }), ' in the latest live run on main, ' + ago(run.updated_at) + ' (' +
          new Date(run.updated_at).toLocaleString() + ', ' + run.event + ', ' + run.head_sha.slice(0, 7) + '): ',
        el('a', { href: run.html_url, text: 'the run' }), ', ', el('a', { href: runsPage(tile), text: 'all runs' }), '.'
      ]));
      var chips = jobs.filter(browser).map(function (job) {
        return el('span', { 'class': 'chip', 'data-status': jobStatus(job), text: ICONS[jobStatus(job)] + ' ' + browser(job) });
      });
      if (chips.length > 0) status.appendChild(el('div', { 'class': 'chips' }, chips));
      status.appendChild(checked(tile, node, at));
    }).catch(function (error) {
      node.setAttribute('data-status', 'info');
      node.querySelector('.icon').textContent = ICONS.info;
      status.textContent = '';
      status.appendChild(el('span', {}, ['Couldn\u2019t load the latest run: ' + error.message + ' ', el('a', { href: runsPage(tile), text: 'See the runs on GitHub' }), '.']));
      status.appendChild(checked(tile, node, at === undefined ? Date.now() : at));
    });
  }

  // A frame keeps its first-party cookie only when it's the same site as this page (sharedid.dev): elsewhere the
  // browser treats it as a third party. Those tiles open the page instead.
  var here = location.hostname;
  function sameSite(url) {
    var host = new URL(url).hostname;
    return here === 'sharedid.dev' || here.slice(-'.sharedid.dev'.length) === '.sharedid.dev'
      ? host === 'sharedid.dev' || host.slice(-'.sharedid.dev'.length) === '.sharedid.dev'
      : false;
  }

  function tile(spec, live) {
    var node = el('div', { 'class': 'tile', 'data-status': 'pending', 'data-workflow': spec.workflow, 'data-site': spec.site || '' }, [
      el('h3', {}, [el('span', { 'class': 'icon', text: ICONS.pending }), spec.name]),
      el('p', { 'class': 'shape', text: spec.shape }),
      el('div', { 'class': 'run', text: 'Loading the latest run\u2026' })
    ]);
    if (live) {
      var actions = el('div', { 'class': 'actions' }, [
        el('a', { href: spec.site, target: '_blank', rel: 'noopener', text: 'Run it in your browser \u2197' }),
        el('span', { 'class': 'ci-only', text: spec.label || new URL(spec.site).host + new URL(spec.site).pathname })
      ]);
      if (spec.embed && sameSite(spec.site)) {
        var button = el('button', { type: 'button', text: 'Run it here' });
        button.addEventListener('click', function () {
          var existing = node.querySelector('iframe');
          if (existing) { existing.remove(); node.classList.remove('open'); button.textContent = 'Run it here'; return; }
          node.classList.add('open');
          node.appendChild(el('iframe', { src: spec.site, title: spec.name + ': the e2e page' }));
          button.textContent = 'Close';
        });
        actions.insertBefore(button, actions.children[1]);
      }
      node.appendChild(actions);
    } else {
      node.appendChild(el('div', { 'class': 'ci-only', text: 'Runs on a CI machine only: nothing stays up to open.' }));
    }
    load(spec, node);
    return node;
  }

  LIVE.forEach(function (spec) { document.getElementById('live').appendChild(tile(spec, true)); });
  CI.forEach(function (spec) { document.getElementById('ci').appendChild(tile(spec, false)); });
})();
