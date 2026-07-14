# Jenga API — multi-stage build.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @jenga/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY db db
RUN pnpm --filter @jenga/shared build && pnpm --filter @jenga/api build
# Compile the migration runner to plain CommonJS for the runtime image.
RUN cd apps/api && ./node_modules/.bin/tsc ../../db/migrate.ts \
      --outDir /repo/db-dist --module commonjs --target es2022 \
      --esModuleInterop --skipLibCheck
# Prune to production dependencies only.
RUN pnpm --filter @jenga/api... deploy --legacy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/packages/shared/dist ./node_modules/@jenga/shared/dist
COPY --from=build /repo/db-dist ./db-dist
COPY --from=build /repo/db/migrations ./db-dist/migrations
USER app
EXPOSE 3000
CMD ["node", "dist/main.js"]
