# syntax=docker/dockerfile:1
# Hanko gateway image: the x402 paywall plus the free POST /api/verify, backed by the zpay-verify core.
# Multi-stage: Rust core on the pinned toolchain, TypeScript build with pnpm, run on node slim as "node".
# No secrets are baked in; the merchant's address and incoming viewing key are runtime env vars.
FROM rust:1.89-bookworm AS core
ARG CARGO_BUILD_JOBS=2
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} CARGO_TERM_COLOR=never
RUN apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY packages/core ./
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked && cp target/release/zpay-verify /zpay-verify

# The published Sapling parameters (zpay-verify checks their BLAKE2b hashes before use), as CI fetches them.
FROM debian:bookworm-slim AS params
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /params && for f in sapling-spend.params sapling-output.params; do \
      curl -fsSL --retry 3 -o /params/$f https://download.z.cash/downloads/$f; done

FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV CI=true
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/sdk/package.json packages/sdk/
COPY packages/gateway/package.json packages/gateway/
RUN pnpm install --frozen-lockfile --filter "@zpv/gateway..."
COPY packages/sdk packages/sdk
COPY packages/gateway packages/gateway
RUN pnpm --filter @zpv/sdk build && pnpm --filter @zpv/gateway build \
 && pnpm install --frozen-lockfile --prod --filter "@zpv/gateway..."

FROM node:22-bookworm-slim AS run
ENV NODE_ENV=production ZPV_BIN=/usr/local/bin/zpay-verify ZPV_SAPLING_PARAMS=/opt/zcash-params \
    ZPV_HOST=0.0.0.0 ZPV_PORT=8403 ZPV_STORE=/data/zpv.sqlite
COPY --from=core /zpay-verify /usr/local/bin/zpay-verify
COPY --from=params /params /opt/zcash-params
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /data && chown node:node /data && chmod 700 /data
USER node
EXPOSE 8403
CMD ["node", "packages/gateway/dist/main.js"]
