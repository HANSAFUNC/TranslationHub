# Shared image for api / worker / mcp-remote (they run the same compiled workspace).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apk add --no-cache openssl dumb-init
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# Manifests only, deliberately. Copying `packages/` wholesale — which is what this used to do —
# makes the install layer depend on every source file in the workspace, so editing one TypeScript
# file re-downloads the entire dependency tree. That is slow when the network is good and fatal
# when it is not, and it is not a cache the build should have been giving up.
COPY packages/config/package.json ./packages/config/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY packages/database/package.json ./packages/database/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/format-adapters/package.json ./packages/format-adapters/package.json
COPY packages/local-sync/package.json ./packages/local-sync/package.json
COPY packages/permissions/package.json ./packages/permissions/package.json
COPY packages/sync-engine/package.json ./packages/sync-engine/package.json
COPY packages/workspace/package.json ./packages/workspace/package.json
COPY packages/api-client/package.json ./packages/api-client/package.json
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/mcp-remote/package.json ./apps/mcp-remote/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/e2e-demo/package.json ./apps/e2e-demo/package.json
COPY apps/web/package.json ./apps/web/package.json
# `--fetch-retries` and friends: the default of 2 retries gives up on a registry that is merely
# slow, and a build that fails at 662 of 664 packages wastes the whole download.
RUN pnpm install --frozen-lockfile --ignore-scripts \
      --fetch-retries=10 --fetch-retry-mintimeout=5000 --fetch-retry-maxtimeout=120000 --fetch-timeout=600000

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# Prisma Client must exist before any package that imports it is compiled.
#
# `prisma generate` downloads the query engine, and on a slow registry that download can abort with
# an ECONNRESET that kills the process outright — the retry the message promises never runs, so the
# build fails at 90% and starts over. Retrying here is what actually survives a flaky network.
RUN set -e; \
    for attempt in 1 2 3 4 5; do \
      if pnpm --filter @localehub/database exec prisma generate; then break; fi; \
      if [ "$attempt" = 5 ]; then echo "prisma generate failed after 5 attempts" >&2; exit 1; fi; \
      echo "prisma generate failed (attempt $attempt); retrying in 10s" >&2; \
      sleep 10; \
    done \
 && pnpm --filter './packages/**' build \
 && pnpm --filter @localehub/api --filter @localehub/worker --filter @localehub/mcp-remote --filter @localehub/local-sync --filter @localehub/cli build

FROM base AS runtime
ENV NODE_ENV=production
# Never let corepack fetch a package manager at container start.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
# pnpm keeps per-workspace symlink trees under each package, so the whole build output is
# copied instead of hand-picking directories (a partial copy breaks module resolution).
COPY --from=build /app /app
RUN chown -R node:node /app
USER node
EXPOSE 3001
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/api/dist/main.js"]
