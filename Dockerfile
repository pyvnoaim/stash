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
COPY server/index.ts ./server/index.ts
ENV NODE_ENV=production STASH_DB=/data/stash.db STASH_ROOT=/app/dist PORT=8787
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.ts"]
