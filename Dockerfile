# WISSen Production Dockerfile
# Base: mcr.microsoft.com/playwright:v1.59.1-jammy (Node 24 + Chromium + system deps)
# IMPORTANT: Playwright version MUST match package.json exactly (browser binaries are version-locked).
# Multi-stage: deps -> runtime. Container starts as root so the entrypoint can
# apply PUID/PGID and chown the bind-mounted volume; the entrypoint then drops
# privileges to the unprivileged `app` user via gosu.

# --------- base: Playwright + Node 24 ---------
# Pinned to manifest-list digest so the build is reproducible and supply-chain
# safe (a compromised tag does not auto-pull). Dependabot (docker ecosystem in
# .github/dependabot.yml) opens a PR when Microsoft publishes a new digest, so
# patches still flow in — just gated by review instead of silently picked up.
FROM mcr.microsoft.com/playwright:v1.61.0-jammy@sha256:264136758e43332108f6420f82c47f639f619ca65301065ceade677763f477ec AS base
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    TZ=Europe/Zurich

# Pull latest security patches from Ubuntu + upgrade bundled npm
# (fixes Trivy HIGH in /usr/lib/node_modules/npm: tar, minimatch, picomatch,
#  and MEDIUM/LOW in openssl, libssl3, libudev1, libgdk-pixbuf, libcap2,
#  libgraphite2 1.3.14-1ubuntu0.1 — CVE-2026-50593 integer-underflow / OOB read)
# npm 11.17.0 also bundles brace-expansion 5.0.6 (CVE-2026-45149) and
# tar 7.5.16 (node-tar PAX long-name/long-link header smuggling) — fixes the
# two remaining Trivy MEDIUMs in /usr/lib/node_modules/npm.
# Also installs gosu for PUID/PGID privilege drop in the entrypoint.
# DEBIAN_FRONTEND=noninteractive prevents tzdata's interactive geographic-area
# prompt during `apt upgrade` from blocking the build.
#
# APT_REFRESH busts the GHA buildx cache for this layer when new Ubuntu
# security patches land between base-image digest bumps. CI passes the current
# date (YYYY-MM-DD) so PR/push builds on the same day share cache (fast) while
# the first build of each day pulls fresh apt security state. Local builds use
# the default below; bump it manually if you need a forced refresh.
USER root
ARG DEBIAN_FRONTEND=noninteractive
ARG APT_REFRESH=2026-06-18
# libc-bin's ldconfig post-install script intermittently SIGSEGVs (exit 139)
# under qemu-user-static during the linux/arm64 leg of buildx multi-arch
# builds. apt then aborts the whole `upgrade` with "Sub-process /usr/bin/dpkg
# returned an error code (1)" even though every other package installed fine.
# Retrying with `dpkg --configure -a` finishes the half-configured package on
# the next attempt — observed working consistently for this base image.
# Reference: https://github.com/docker-library/official-images/issues/16637
#
# hadolint ignore=DL3008
# Begründung: gosu/tzdata werden vom upstream Playwright-Base auf den jeweils
# letzten apt-Stand erwartet (Ubuntu phases out exact apt versions in security
# pockets, pinning bricht den Build wenn der pin nach dem nächsten Ubuntu-
# Security-Refresh nicht mehr existiert). APT_REFRESH cache-bust + npm pin
# (Zeile darunter) decken die supply-chain-Seite ab.
RUN echo "apt-refresh=${APT_REFRESH}" \
 && ln -fs /usr/share/zoneinfo/Europe/Zurich /etc/localtime \
 && echo "Europe/Zurich" > /etc/timezone \
 && apt-get update \
 && (apt-get upgrade -y || (dpkg --configure -a && apt-get upgrade -y)) \
 && (apt-get install -y --no-install-recommends gosu tzdata \
     || (dpkg --configure -a && apt-get install -y --no-install-recommends gosu tzdata)) \
 && gosu nobody true \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g npm@11.17.0 \
 && npm cache clean --force

# --------- deps: install production dependencies ---------
# `--ignore-scripts` skips the root package.json's `postinstall` hook
# (which runs `cd web-svelte && npm install` for local dev convenience).
# In Docker the SvelteKit frontend is built in its own dedicated stage
# below; we don't want web-svelte's dev-deps polluting the runtime image.
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# --------- webbuild: compile the SvelteKit V2 frontend → dist/ ---------
# Separate stage so the SvelteKit / Vite / TypeScript dev-deps stay out
# of the runtime image. Output is copied into runtime as plain static
# files; Express serves them at site root via static.js.
#
# NODE_ENV=development is REQUIRED for this stage: the base image inherits
# NODE_ENV=production, which makes `npm ci` silently drop every entry from
# devDependencies — and vite + @sveltejs/kit live there. Without this
# override the build dies with "sh: 1: vite: not found" at exit code 127.
# `--include=dev` alone isn't enough on newer npm: the env var still wins.
FROM base AS webbuild
ENV NODE_ENV=development
WORKDIR /app/web-svelte
COPY web-svelte/package.json web-svelte/package-lock.json ./
RUN npm ci --include=dev --ignore-scripts && npm cache clean --force
COPY web-svelte/. ./
# adapter-static writes to ../dist (configured in svelte.config.js), so
# the build artefact lands at /app/dist after this RUN.
RUN npm run build

# --------- runtime: final production image ---------
FROM base AS runtime

# Create app user (playwright image already has 'pwuser' but for clarity, use app)
RUN groupadd -r app && useradd -r -g app -m -d /home/app app

WORKDIR /app

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy app files with correct ownership
COPY --chown=app:app package.json package-lock.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app web ./web

# Copy compiled SvelteKit V2 frontend from the webbuild stage. Lands at
# /app/dist; Express's static.js mounts this first so site root '/' and
# all SPA routes resolve here. Legacy /mobile/ + /assets/ + /floorplans/
# fall through to /app/web below.
COPY --from=webbuild --chown=app:app /app/dist ./dist

# Entrypoint: PUID/PGID handling + gosu privilege drop
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create data + cache directories, set ownership
# - /app/data  : runtime volume (SQLite DB, storage.json, .api-token)
# - /home/app/.cache : Playwright/npm cache fallback (image ships browsers in /ms-playwright)
RUN mkdir -p /app/data /home/app/.cache \
    && chown -R app:app /app /home/app \
    && chmod 750 /app/data

# Container starts as root so the entrypoint can apply PUID/PGID and chown
# the volume; the entrypoint then drops to the `app` user via gosu.
#
# hadolint ignore=DL3002
# Begründung: USER root am Ende ist hier intendiert. Der entrypoint braucht
# root um PUID/PGID auf die bind-mounted volume anzuwenden und chownt /app/data
# bevor er via `gosu app` auf den unprivileged `app` user wechselt. Ein
# permanentes USER app würde PUID/PGID-Handling unmöglich machen.

EXPOSE 3000

# Healthcheck: verify server is responding on /healthz
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Run server with experimental-sqlite flag (Node 22+ feature)
CMD ["node", "--experimental-sqlite", "--no-warnings=ExperimentalWarning", "src/server.js"]
