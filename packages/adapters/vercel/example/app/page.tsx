import type { ReactNode } from 'react';

export default function Home(): ReactNode {
  return (
    <main>
      <h1>SharedID Edge on Vercel</h1>
      <p>
        This site answers <a href="/_sid/v1">/_sid/v1</a> and <code>/_sid/sync</code> from its own deployment. Point
        Prebid.js&apos;s <code>sharedIdSystem</code> <code>pixelUrl</code> at <code>/_sid/sync</code>.
      </p>
    </main>
  );
}
