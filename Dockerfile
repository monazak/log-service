# ---------- Stage 1: build ----------
FROM node:24-alpine AS builder

WORKDIR /app

# Dependency manifests first: this layer is cached unless they change, so a
# code-only edit skips the slowest step in the build.
COPY package.json package-lock.json ./

# ci rather than install: exact versions from the lockfile, and it fails rather
# than silently updating one.
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Compiles src/ to dist/ and copies migrations/ alongside it — tsc does not
# copy .sql files, so the build script does it explicitly.
RUN npm run build


# ---------- Stage 2: runtime ----------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Production dependencies only. TypeScript, Vitest, and Biome never reach the
# runtime image — smaller surface, smaller image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Only compiled output crosses the stage boundary. Source, tsconfig, and dev
# dependencies stay behind.
COPY --from=builder /app/dist ./dist

# Ownership, not just identity: files copied as root leave the node user with
# read-only access to its own working directory, which fails the moment
# anything needs to write a temp file.
RUN chown -R node:node /app

# Non-root. The alpine image ships this user; creating one is unnecessary.
USER node

EXPOSE 8080

# Exec form, not shell form. Shell form wraps the process in /bin/sh, which
# does not forward SIGTERM — the graceful shutdown handler would never run and
# Docker would kill the container after the grace period instead.
CMD ["node", "dist/index.js"]