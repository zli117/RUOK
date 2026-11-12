# Syntax=docker/dockerfile:1
#
# RUOK production image (WP09 / T033-T036).
#
# One image runs the SAME backend in SQLite or PostgreSQL mode:
#   - SQLite:      DATABASE_TYPE=sqlite (default) + DATABASE_PATH + data volume
#   - PostgreSQL:  DATABASE_TYPE=postgres + DATABASE_URL (external DB, NO SQLite volume)
#
# The build is database-free: `npm ci` (committed lockfile) + `npm run build`
# never open or create a database and require no network credentials. Both
# migration histories (drizzle/ + drizzle-postgres/) and the compiled migration
# entrypoint are copied into the runtime image so migrations run with
# production dependencies only.

###############################################################################
# Stage 1: builder
###############################################################################
FROM node:22-alpine AS builder

# Native module prerequisites (better-sqlite3, bcrypt) compile from source on
# Alpine/musl. These are build-time only.
RUN apk add --no-cache python3 make g++ sqlite

WORKDIR /app

# Reproducible install from the committed lockfile. No database is created or
# opened here. `prepare` (svelte-kit sync) is harmless.
COPY package*.json ./
RUN npm ci

# Copy the full source (build context). No DB files are copied (see .dockerignore).
COPY . .

# Production SvelteKit build (adapter-node -> build/). No DB access.
# WP10: the Vite build hook also emits SQLite worker assets into build/workers/
# (runtime.mjs + preparation.mjs); they are carried into the runtime stage below
# automatically with the rest of build/.
RUN npm run build

# Bundle the standalone migration CLI (FR-004/FR-005) into the build output.
# `--packages=external` keeps better-sqlite3/pg/drizzle-orm as runtime imports
# resolved from production node_modules. The compiled entrypoint is carried
# into the runtime stage automatically with build/.
RUN npx esbuild scripts/db-migrate.ts \
    --bundle --platform=node --packages=external --format=esm \
    --outfile=build/db-migrate.mjs

# Prune dev dependencies: only packages needed at runtime remain.
RUN npm prune --production

###############################################################################
# Stage 2: production (non-root)
###############################################################################
FROM node:22-alpine AS production

# Runtime needs the shared libs that the Alpine-compiled native modules link
# against (node:alpine already ships libstdc++/libgcc). `sqlite` is not needed
# because better-sqlite3 bundles its own; kept minimal on purpose.
RUN apk add --no-cache libstdc++

WORKDIR /app

# Create a non-root user.
RUN addgroup -g 1001 -S nodejs && \
    adduser -S ruok -u 1001 -G nodejs

# Copy the built app, production node_modules, package metadata and BOTH
# migration histories (SQLite drizzle/ + PostgreSQL drizzle-postgres/) plus the
# compiled migration entrypoint (already inside build/).
COPY --from=builder --chown=ruok:nodejs /app/build ./build
COPY --from=builder --chown=ruok:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=ruok:nodejs /app/package.json ./
COPY --from=builder --chown=ruok:nodejs /app/drizzle ./drizzle
COPY --from=builder --chown=ruok:nodejs /app/drizzle-postgres ./drizzle-postgres

# SQLite data directory. Writable by the non-root user. In PostgreSQL mode this
# directory is present but unused (no SQLite filesystem dependency).
RUN mkdir -p /app/data && chown ruok:nodejs /app/data

# Runtime environment. DATABASE_TYPE defaults to sqlite in code; the default
# DATABASE_PATH resolves to /app/data/okr.db given WORKDIR /app. No secrets.
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/okr.db

EXPOSE 3000

# Liveness is /api/health (process up, login-independent). Readiness is
# /api/ready (backend open AND migrated). The healthcheck gates on full
# readiness so the container is only "healthy" after migrations succeed.
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER ruok
CMD ["node", "build"]