import { createServer, type Server } from 'node:http';
import { ConfigError } from '@sharedid-edge/core';

/** The health check's path, on its own port (`HEALTH_PORT`). */
export const HEALTH_PATH = '/healthz';

/**
 * A server that answers `GET` or `HEAD /healthz` with `200 ok`, and anything else with a 404, for a container's
 * health check or a Kubernetes probe. It runs on its own port, never the public one, so the public listener keeps
 * answering only SharedID Edge's routes, and a probe never mints an ID. It answers once the server has started, which
 * means its configuration was valid: the CLI exits at start-up when it isn't.
 */
export function createHealthServer(): Server {
  return createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const ok = path === HEALTH_PATH && (req.method === 'GET' || req.method === 'HEAD');
    res.writeHead(ok ? 200 : 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : ok ? 'ok\n' : 'Not found\n');
  });
}

/**
 * `HEALTH_PORT`: undefined when unset or blank (no health server), otherwise a port number other than `port`, the
 * public one. Anything else is a configuration error.
 */
export function healthPortFromEnv(value: string | undefined, port: number): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const healthPort = Number(value);
  if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65535) throw new ConfigError('HEALTH_PORT must be a port number (1 to 65535)');
  if (healthPort === port) throw new ConfigError('HEALTH_PORT must differ from PORT: the health check has its own listener');
  return healthPort;
}
