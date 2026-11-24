// A stub of ID5's fetch endpoint as its own HTTP server, so the `id5` module's request really leaves the server: the
// Node.js target runs it as a child process, and the `docker` target as a container next to the server's (the server's
// image, with `node` as the entry point, on the host's network). The server reaches it through the upstream stand-in's
// `CONFORMANCE_ID5_STUB` (upstream-stand-in.ts), a test preload no build includes; the browser never does.
//
// - `POST <any path>`: ID5's answer, as the in-memory stand-in gives it (`id5StandIn`: one EID echoing what was sent in
//   `ext.sent`, or ID5's opt-out for a `ua` with `ID5_OPT_OUT_MARKER`). Each request's JSON body is recorded.
// - `GET /__requests`: the bodies recorded so far, as a JSON array, for id5-checks.ts.
// - `GET /__conformance_ready`: `ok`, for the targets' start-up wait.
//
//   node conformance/dist/id5-stub.js <port>    # listens on 127.0.0.1:<port>
import { createServer, type Server } from 'node:http';
import { argv } from 'node:process';
import { pathToFileURL } from 'node:url';
import { id5StandIn } from './upstream-stand-in.js';

/** The largest request body read, in bytes. */
const MAX_BODY = 65_536;

/** Starts the stub on 127.0.0.1:`port`; resolves to the server once it's listening. */
export function startId5Stub(port: number): Promise<Server> {
  const recorded: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      void (async () => {
        if (req.method === 'GET' && req.url === '/__requests') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(recorded));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(req.url === '/__conformance_ready' ? 200 : 404, { 'content-type': 'text/plain' }).end('ok');
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        try {
          recorded.push(JSON.parse(text));
        } catch {
          recorded.push(null);
        }
        const answer = await id5StandIn(new Request(`http://127.0.0.1${req.url ?? '/'}`, { method: 'POST', body: text }));
        res.writeHead(answer.status, { 'content-type': 'application/json' }).end(await answer.text());
      })();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { resolve(server); });
  });
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
  const port = Number(argv[2]);
  if (!Number.isInteger(port) || port <= 0) throw new Error('usage: node id5-stub.js <port>');
  await startId5Stub(port);
}
