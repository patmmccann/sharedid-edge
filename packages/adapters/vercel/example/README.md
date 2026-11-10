# SharedID Edge on Vercel: Next.js example

A minimal Next.js (App Router) site that serves SharedID Edge on `/_sid/*` from its own deployment, the way a publisher's site would. The whole integration is one file, `app/%5Fsid/[...path]/route.ts`, plus the bundle copied into `lib/`. See the [adapter's README](../README.md) for the full guide.

It isn't part of the repository's build: Next.js is a large install, so it has its own `package.json`, and CI doesn't build it.

## Run it locally

Node.js 24 or later. From a fresh clone:

```sh
cd packages/adapters/vercel/example
npm install
cp .env.example .env.local                  # optional: SID_* settings
npm run build && npm start                  # or npm run dev
```

`npm run build` and `npm run dev` first build the SharedID Edge bundle from the repository if it isn’t there yet (`npm ci`, `npm run build` and `npm run bundle -w @sharedid-edge/vercel` at the root), then copy it into `lib/`. After changing the adapter, rebuild it with `npm run build && npm run bundle -w @sharedid-edge/vercel` at the root.

Then:

```sh
curl -sI 'http://localhost:3000/_sid/sync?id=pubcid:test-id'   # 200, image/gif, two set-cookie (not Secure over http)
curl -s  'http://localhost:3000/_sid/v1'
```

Locally there's no Vercel proxy, so there's no client IP or location unless you send Vercel's headers yourself (for example `-H 'x-vercel-ip-country: DE'`, which makes GDPR apply). `next start` trusts them because `SID_BEHIND_VERCEL` defaults to `true`; on any server other than Vercel, set it to `false`.

## Deploy it

Import the repository as a Vercel project with:

- **Root Directory:** `packages/adapters/vercel/example`.
- **Include files outside the root directory in the Build Step:** on (Vercel’s default). The build needs the rest of the repository to build the bundle.
- **Node.js version:** 24.x.
- **Build command:** the default (`npm run build`). Its `prebuild` step builds the bundle from the repository, as above, so nothing generated needs to be committed.
- **Environment variables:** the `SID_*` settings, with `SID_MODULE_SECRETS` marked sensitive.

Then deploy. For a real site, copy `lib/sharedid-edge.mjs`, `lib/sharedid-edge.d.mts` and the route file into the site's own project instead: the endpoint must be served by the project that serves your pages, on your own domain.
