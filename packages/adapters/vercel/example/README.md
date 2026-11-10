# SharedID Edge on Vercel: Next.js example

A minimal Next.js (App Router) site that serves SharedID Edge on `/_sid/*` from its own deployment, the way a publisher's site would. The whole integration is one file, `app/%5Fsid/[...path]/route.ts`, plus the bundle copied into `lib/`. See the [adapter's README](../README.md) for the full guide.

It isn't part of the repository's build: Next.js is a large install, so it has its own `package.json`, and CI doesn't build it.

## Run it locally

Node.js 24 or later. From the repository root:

```sh
npm ci
npm run build
npm run bundle -w @sharedid-edge/vercel     # deploy/sharedid-edge.mjs, which the example copies into lib/
cd packages/adapters/vercel/example
npm install
cp .env.example .env.local                  # optional: SID_* settings
npm run build && npm start                  # or npm run dev
```

Then:

```sh
curl -sI 'http://localhost:3000/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie (not Secure over http)
curl -s  'http://localhost:3000/_sid/v1'
```

Locally there's no Vercel proxy, so there's no client IP or location unless you send Vercel's headers yourself (for example `-H 'x-vercel-ip-country: DE'`, which makes GDPR apply). `next start` trusts them because `SID_BEHIND_VERCEL` defaults to `true`; on any server other than Vercel, set it to `false`.

## Deploy it

Import the folder as a Vercel project (root directory `packages/adapters/vercel/example`), add the `SID_*` environment variables, and deploy. For a real site, copy `lib/sharedid-edge.mjs`, `lib/sharedid-edge.d.mts` and the route file into the site's own project instead: the endpoint must be served by the project that serves your pages, on your own domain.
