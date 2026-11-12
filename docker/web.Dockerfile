FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/web/package.json ./apps/web/package.json
# Same retry budget as `docker/api.Dockerfile`: the default of 2 gives up on a registry that is
# merely slow, and the web dependency set is the largest in the workspace.
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @localehub/web... \
      --fetch-retries=10 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
# `rewrites()` runs at build time and its destination is baked into routes-manifest.json, so the
# address the web container proxies `/api/v1` to has to be decided here. Setting
# API_BASE_URL_INTERNAL only in the runtime environment looks like it works — the container starts
# and every HTML route still returns 200 — but the proxy keeps a destination of localhost:3001,
# which inside the container is the web container itself, and every API call 500s.
ARG API_BASE_URL_INTERNAL=http://localhost:3001/api/v1
ENV API_BASE_URL_INTERNAL=$API_BASE_URL_INTERNAL
# The web app imports `@localehub/contracts` (locale catalog, shared types), and that package's
# entry point is its build output — copying the source is not enough. It did not matter until the
# app started importing it.
RUN pnpm --filter @localehub/contracts build \
 && pnpm --filter @localehub/web build

FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# The standalone Next.js output plus its static assets; pnpm's per-package node_modules
# layout means the app directory is copied as a whole.
COPY --from=build /app /app
RUN chown -R node:node /app
USER node
# Next.js resolves `.next` relative to the working directory, so start inside the app.
WORKDIR /app/apps/web
EXPOSE 3000
# Run next directly: corepack would otherwise try to download pnpm at container start.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
