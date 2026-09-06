# Builds the app and serves it next to the sync endpoint, so the VPS runs one container.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
# The one thing the app cannot do for itself. A card's clip is recorded by the browser, and the
# Firefox family records WebM and nothing else — which chat apps file as a document rather than
# play. /api/clip hands those bytes to this and gives back H.264/AAC. See server/clip.ts.
RUN apk add --no-cache ffmpeg
COPY --from=build /app/dist ./dist
COPY server/index.ts server/push.ts server/cal.ts server/blob.ts server/clip.ts server/bitget.ts server/mexc.ts server/trade.ts server/mcp.ts ./server/
# What the server shares with the app: the market maths for push.ts, and — for the hosted /mcp
# route — the store, the parser and the hotkey table the store leans on. store.ts imports react
# (one hook, never called out here), which is why a single dependency rides into the image.
COPY src/lib/market.ts src/lib/store.ts src/lib/parse.ts src/lib/keys.ts ./src/lib/
COPY --from=build /app/node_modules/react ./node_modules/react
# The database is the only thing this process writes, and it does not need to be root to do it.
# Docker stamps a freshly created named volume with the ownership the image has on that path, so
# /data belongs to node from the first `up`. An existing volume keeps whatever it already had —
# see compose.yml for the one-time chown. The app itself stays root-owned and read-only to node.
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production STASH_DB=/data/stash.db STASH_ROOT=/app/dist PORT=8787
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
