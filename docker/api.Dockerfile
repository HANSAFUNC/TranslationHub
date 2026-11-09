# Shared image for api / worker / mcp-remote (they run the same compiled workspace).
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && apk add --no-cache openssl dumb-init
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
COPY apps/worker/package.json ./apps/worker/package.json
COPY apps/mcp-remote/package.json ./apps/mcp-remote/package.json
COPY apps/mcp-local/package.json ./apps/mcp-local/package.json
COPY apps/cli/package.json ./apps/cli/package.json
COPY apps/e2e-demo/package.json ./apps/e2e-demo/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages
# Prisma Client must exist before any package that imports it is compiled.
RUN pnpm --filter @localehub/database exec prisma generate \
 && pnpm --filter './packages/**' build \
 && pnpm --filter @localehub/api --filter @localehub/worker --filter @localehub/mcp-remote --filter @localehub/mcp-local --filter @localehub/cli build

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
