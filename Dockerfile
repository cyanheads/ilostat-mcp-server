# ==============================================================================
# Build Stage
#
# This stage installs all dependencies (including dev), builds the TypeScript
# source code into JavaScript, and prepares the production assets.
#
# Pinned to $BUILDPLATFORM rather than the target platform: `bun run build` emits
# JavaScript, and only `dist/` crosses into the production stage, which takes
# its dependencies from the target-arch install in the deps stage below. Built
# for the target instead, the non-native leg of a
# `--platform linux/amd64,linux/arm64` build runs under QEMU, where bun >= 1.4
# aborts with a JavaScriptCore allocator assertion and fails the multi-arch push.
#
# The constraint this assumes: the build stage produces platform-independent
# output. A stage that compiles a native addon needs the target-arch toolchain
# and cannot cross-compile this way — drop the flag there.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build

WORKDIR /usr/src/app

# Copy dependency manifests for optimized layer caching
COPY package.json bun.lock ./

# Install all dependencies (including dev dependencies for building).
# The BuildKit cache mount persists Bun's global package cache across builds.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts

# Copy the rest of the source code
COPY . .

# Build the application
RUN bun run build


# ==============================================================================
# Production Dependencies Stage
#
# Installs the production dependency tree for the target platform while running
# on $BUILDPLATFORM, so no JavaScript runs under QEMU. Both installs below run
# JavaScript: Bun spawns the security scanner bunfig.toml names as `bun -e`,
# and the OpenTelemetry step reads the framework's peer ranges with `bun -e`.
# Under emulation, bun >= 1.4 aborts on them as it does on `bun run build`.
#
# `--os=linux --cpu=<arch>` makes Bun select optional dependencies for the target
# instead of the machine it runs on. That carries DuckDB's native binding:
# @duckdb/node-api (a direct dependency) loads @duckdb/node-bindings, whose
# per-platform packages (node-bindings-linux-x64, -linux-arm64, and their musl
# variants) are optional dependencies gated on os and cpu. Without the flags,
# Bun installs only those matching the build host, and the other architecture
# of a linux/amd64,linux/arm64 build would lose DuckDB. Never copy node_modules
# from the build stage for the same reason: its tree holds the build host's
# binding alone, plus every devDependency.
# ==============================================================================
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS deps

WORKDIR /usr/src/app

# Copy dependency manifests. `bunfig.toml` rides along so every install below
# passes its release-age gate and security scanner, as a local install does.
COPY package.json bun.lock bunfig.toml ./

# The scanner bunfig.toml names is a devDependency, and Bun installs a missing
# scanner through the same production-filtered install, which omits it and
# aborts. Seed it from the build stage's full install instead. Remove this line,
# and the `rm` at the end of this stage, if bunfig.toml stops naming a scanner.
COPY --from=build /usr/src/app/node_modules/@socketsecurity/bun-security-scanner ./node_modules/@socketsecurity/bun-security-scanner

# Install only production dependencies, ignoring any lifecycle scripts (like 'prepare')
# that are not needed in the final production image.
# `--omit=peer` drops the framework's optional peer tiers (test runner, service
# SDKs, parsers) that Bun would otherwise auto-install. Anything this server
# actually imports belongs in its own `dependencies`, so nothing needed at
# runtime is lost. The OTEL `bun add` carries the same flag, and the same
# `--os`/`--cpu` pair — without them, that install re-resolves the graph, pulls
# every optional peer back in, and adds the build host's DuckDB binding.
#
# Then conditionally install the OpenTelemetry optional peer dependencies (Tier 3).
# Installed by default. Omit them for a leaner image at build time
# with: docker build --build-arg OTEL_ENABLED=false
# Each package is requested at the range the installed framework declares in
# `peerDependencies`, so the resolution stays inside the framework's tested
# peer range; a name with no declared range fails the build.
#
# TARGETARCH is Docker's name for the target CPU; `case` maps it to Bun's and
# fails the build on an architecture with no mapping.
ARG TARGETARCH
ARG OTEL_ENABLED=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    case "$TARGETARCH" in \
      amd64) cpu=x64 ;; \
      arm64) cpu=arm64 ;; \
      *) echo "No Bun --cpu value for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
    esac \
    && bun install --production --omit=peer --frozen-lockfile --ignore-scripts --os=linux --cpu="$cpu" \
    && if [ "$OTEL_ENABLED" = "true" ]; then \
      specs=$(bun -e ' \
        const { peerDependencies: peers } = await Bun.file("node_modules/@cyanheads/mcp-ts-core/package.json").json(); \
        const names = process.argv.slice(1); \
        const missing = names.filter((name) => !peers?.[name]); \
        if (missing.length > 0) throw new Error(`no peerDependencies range for ${missing.join(", ")}`); \
        console.log(names.map((name) => `${name}@${peers[name]}`).join(" ")); \
      ' \
        @hono/otel \
        @opentelemetry/api-logs \
        @opentelemetry/exporter-logs-otlp-http \
        @opentelemetry/exporter-metrics-otlp-http \
        @opentelemetry/exporter-trace-otlp-http \
        @opentelemetry/instrumentation-http \
        @opentelemetry/instrumentation-pino \
        @opentelemetry/resources \
        @opentelemetry/sdk-logs \
        @opentelemetry/sdk-metrics \
        @opentelemetry/sdk-node \
        @opentelemetry/sdk-trace-node \
        @opentelemetry/semantic-conventions) \
      && bun add --omit=dev --omit=peer --ignore-scripts --os=linux --cpu="$cpu" $specs; \
    fi

# The seeded scanner served only the installs above; keep it out of the image.
RUN rm -rf node_modules/@socketsecurity/bun-security-scanner


# ==============================================================================
# Production Stage
#
# This stage creates a minimal, optimized, and secure image for running the
# application. It uses a slim base image and only includes production
# dependencies and build artifacts.
#
# It runs on the target platform and copies its dependencies in rather than
# installing them, so no instruction here runs JavaScript during the build.
# ==============================================================================
FROM oven/bun:1.4.2-slim AS production

WORKDIR /usr/src/app

# Run the application in production mode.
ENV NODE_ENV=production

# OCI image metadata (https://github.com/opencontainers/image-spec/blob/main/annotations.md)
ARG APP_VERSION
LABEL org.opencontainers.image.title="ilostat-mcp-server"
LABEL org.opencontainers.image.description="Search ILOSTAT labour indicators, query and compare series, build country profiles, run SQL via MCP. STDIO or Streamable HTTP."
LABEL org.opencontainers.image.licenses="Apache-2.0"
LABEL org.opencontainers.image.version="${APP_VERSION}"
LABEL org.opencontainers.image.source="https://github.com/cyanheads/ilostat-mcp-server"

# The framework reads the server's name, version, and description from
# package.json at runtime.
COPY package.json ./

# Copy the production dependencies the deps stage installed for this platform
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy the compiled application code from the build stage
COPY --from=build /usr/src/app/dist ./dist

# The 'oven/bun' image already provides a non-root user named 'bun'.
# We will use this existing user for enhanced security.

# Create the log directory LOGS_DIR names below, where the logger writes its
# file sinks, and assign it to the 'bun' user. Nothing else is written to disk:
# the catalog, response caches, and ctx.state (STORAGE_PROVIDER_TYPE defaults to
# in-memory) live in memory, and DataCanvas scratch files (DuckDB spills,
# spillover staging) go to CANVAS_TEMP_PATH, which defaults to a directory under
# the OS temp dir.
RUN mkdir -p /var/log/ilostat-mcp-server && chown -R bun:bun /var/log/ilostat-mcp-server

# Switch to the non-root user
USER bun

# Define an argument for the port, allowing it to be overridden at build time.
# The `PORT` variable is often injected by cloud environments at runtime.
ARG PORT

# Set runtime environment variables
# Note: PORT is an automatic variable in many cloud environments (e.g., Cloud Run)
ENV MCP_HTTP_PORT=${PORT:-3010}
ENV MCP_HTTP_HOST="0.0.0.0"
ENV MCP_TRANSPORT_TYPE="http"
ENV MCP_SESSION_MODE="stateless"
ENV MCP_LOG_LEVEL="info"
ENV LOGS_DIR="/var/log/ilostat-mcp-server"

# Expose the port the server listens on
EXPOSE ${MCP_HTTP_PORT}

# Health check using a bun-native fetch (slim image ships no curl/wget)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD bun -e "fetch('http://localhost:'+(process.env.MCP_HTTP_PORT??'3010')+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The command to start the server
CMD ["bun", "run", "dist/index.js"]
