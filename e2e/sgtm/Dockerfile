# SharedID Edge's Node.js server (packages/adapters/node), built from this checkout, for the sGTM tests' stack
# (docker-compose.yml). The build context is the repository's root; Dockerfile.dockerignore keeps local installs and
# builds out, so the image builds the same on any machine.
FROM node:24-alpine
WORKDIR /app
COPY . .
# No install scripts: only TypeScript's compiler runs here. tsc -b builds the server and the projects it references.
RUN npm ci --ignore-scripts --no-audit --no-fund && npx tsc -b packages/adapters/node
ENV HOST=0.0.0.0 PORT=8787
USER node
EXPOSE 8787
CMD ["node", "packages/adapters/node/dist/cli.js"]
