# syntax=docker/dockerfile:1
# SharedID Edge's Node.js server as a container image (README.md, "Run in a container"). Build from the repository's
# root, which is the context; Dockerfile.dockerignore keeps local installs and builds out:
#
#   docker build -f packages/adapters/node/Dockerfile -t sharedid-edge-node .
#
# Published for linux/amd64 and linux/arm64 as ghcr.io/patmmccann/sharedid-edge-node on release tags
# (.github/workflows/container.yml).

ARG NODE_IMAGE=node:24-alpine

# Build: the workspace from the lockfile, the server and every opt-in module compiled, then only what the server loads
# copied into /out (scripts/container-tree.mjs). The output is plain JavaScript, so this stage runs on the build
# machine's own platform, also when building for another.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
COPY . .
# No install scripts: only TypeScript's compiler runs here.
RUN npm ci --ignore-scripts --no-audit --no-fund \
 && npx tsc -b $(node scripts/container-tree.mjs --projects) \
 && node scripts/container-tree.mjs /out

FROM ${NODE_IMAGE}
ARG VERSION=dev
ARG REVISION=unknown
ARG CREATED=unknown
LABEL org.opencontainers.image.title="SharedID Edge (Node.js server)" \
      org.opencontainers.image.description="Keeps the Prebid SharedID cookie durable by setting it from your own domain: the Node.js server, behind your proxy" \
      org.opencontainers.image.source="https://github.com/patmmccann/sharedid-edge" \
      org.opencontainers.image.url="https://sharedid.dev" \
      org.opencontainers.image.documentation="https://github.com/patmmccann/sharedid-edge/blob/main/packages/adapters/node/README.md#run-in-a-container" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.created="${CREATED}"
# HOST: every interface of the container, so a published port or a proxy in another container reaches it (the CLI's
# own default is 127.0.0.1). HEALTH_PORT: the health check's own listener (GET /healthz), apart from the public one.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    HEALTH_PORT=8788
WORKDIR /app
COPY --from=build /out /app
# The node user of the official image, by number, so Kubernetes' runAsNonRoot can check it. The server writes nothing.
USER 1000:1000
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT || 8788) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Invalid settings stop the server at once with "Configuration error: …" and exit code 1, so a misconfigured
# container never serves cookies. SIGTERM closes the listeners and exits.
ENTRYPOINT ["node", "/app/node_modules/@sharedid-edge/node/dist/cli.js"]
