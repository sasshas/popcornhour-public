# syntax=docker/dockerfile:1

# Node 24. Only fall back to 22 if better-sqlite3 will not install on 24:
#   docker build --build-arg NODE_VERSION=22 -t popcornhour .
ARG NODE_VERSION=24

# ---------- builder: install dependencies and build the standalone server ----------
FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app

# Build tools for node-gyp, in THIS stage only (the runtime stage below has no compilers).
# better-sqlite3 ships a prebuilt binary (prebuilds/linux-x64.node) and its loader uses it, but the
# package also contains a binding.gyp with no install script, so npm always runs an implicit
# `node-gyp rebuild`. That step compiles nothing when a matching prebuild exists, yet node-gyp is
# Python-based and fails at "configure" without python3. make + g++ are there so a real source build
# also succeeds if the prebuilt binary is ever not usable.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# Lockfile first so the dependency layer is cached until package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build
# Result: /app/.output, a self-contained server (bundled app + traced node_modules).

# Nitro copies better-sqlite3 into .output by tracing, which finds the prebuilt binary
# (prebuilds/<platform>-<arch>.node). A binary compiled from source lands in build/Release instead,
# and the loader locates that one via a runtime path lookup that tracing cannot see, so copy it into
# the output explicitly. Then load the module FROM .output and run a query: the build fails here, not
# at container start, if the native binding is missing or unusable.
RUN set -eu; \
    src=node_modules/better-sqlite3; dest=.output/server/node_modules/better-sqlite3; \
    if [ -f "$src/build/Release/better_sqlite3.node" ]; then \
      mkdir -p "$dest/build" && cp -r "$src/build/Release" "$dest/build/"; \
    fi; \
    node -e "const b=require('./$dest/lib/binding'); const D=require('./$dest'); const v=new D(':memory:').prepare('select sqlite_version() v').get().v; console.log('better-sqlite3 OK: sqlite', v, '| binding:', b.getPrebuildPath() || 'build/Release (compiled from source)')"

# ---------- runtime: just Node and .output ----------
# Same base image (OS + CPU architecture) as the builder, so the native binding matches.
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DB_PATH=/data/app.db
# No secrets here. APP_PASSWORD, SESSION_SECRET, PUBLIC_URL, TMDB_API_KEY, TRAKT_*, OMDB_API_KEY and
# CRON_SECRET are supplied at run time (docker-compose.yml / --env-file); see .env.example.

COPY --from=builder /app/.output ./.output

# Prove the native binding loads in the image that is actually shipped (no compilers in here).
RUN node -e "const b=require('./.output/server/node_modules/better-sqlite3/lib/binding'); const D=require('./.output/server/node_modules/better-sqlite3'); const v=new D(':memory:').prepare('select sqlite_version() v').get().v; console.log('better-sqlite3 OK in runtime image: sqlite', v, '| binding:', b.getPrebuildPath() || 'build/Release')"

# uid 99 / gid 100 is nobody:users on Unraid, so the ./data bind mount is writable without chown games.
# For a named volume (or a fresh bind mount) /data starts out owned by 99:100 as well.
RUN mkdir -p /data && chown 99:100 /data
USER 99:100
VOLUME /data
EXPOSE 8080

# /login is served by the app itself and touches no external service.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
