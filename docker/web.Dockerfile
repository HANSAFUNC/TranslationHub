FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json ./packages/contracts/package.json
COPY apps/web/package.json ./apps/web/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @localehub/web...

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts ./packages/contracts
COPY apps/web ./apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @localehub/web build

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
