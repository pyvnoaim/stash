# Builds the app and serves it next to the sync endpoint, so the VPS runs one container.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY server/index.ts server/blob.ts server/mcp.ts ./server/
# What the server shares with the app, for the hosted /mcp route: the document's rules and the
# capture parser. Neither imports anything, so no node_modules ride into the image.
COPY src/lib/core.ts src/lib/parse.ts ./src/lib/
# The database is the only thing this process writes, and it does not need to be root to do it.
# Docker stamps a freshly created named volume with the ownership the image has on that path, so
# /data belongs to node from the first `up`. An existing volume keeps whatever it already had —
# see compose.yml for the one-time chown. The app itself stays root-owned and read-only to node.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production STASH_DB=/data/stash.db STASH_ROOT=/app/dist PORT=8787
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
