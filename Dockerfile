# syntax=docker/dockerfile:1

# ============================================================================
# Build stage
# ============================================================================
FROM node:22-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json .openrabbit.yaml ./
COPY src ./src
COPY public ./public

RUN npm run build

# ============================================================================
# Lite runtime (default) — Node.js + git + built-in AST/heuristic engine
# ============================================================================
FROM node:22-alpine AS lite

WORKDIR /app

RUN apk add --no-cache git ca-certificates \
 && mkdir -p /app/data \
 && chown -R node:node /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/.openrabbit.yaml ./

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3847
ENV OPENRABBIT_DATA_DIR=/app/data

EXPOSE 3847

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3847/healthz').then((r) => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1));"

CMD ["node", "dist/cli/index.js", "serve"]

# ============================================================================
# Full runtime (opt-in) — Semgrep, Trivy, and Gitleaks
# ============================================================================
FROM lite AS full

USER root

ARG TARGETARCH
ARG SEMGREP_VERSION=1.185.0
ARG TRIVY_VERSION=0.76.2
ARG GITLEAKS_VERSION=8.30.1

RUN apk add --no-cache python3 py3-pip curl tar \
 && pip3 install --no-cache-dir --break-system-packages "semgrep==${SEMGREP_VERSION}"

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) TRIVY_ARCH="64bit"; GITLEAKS_ARCH="x64" ;; \
      arm64) TRIVY_ARCH="ARM64"; GITLEAKS_ARCH="arm64" ;; \
      *) echo "Unsupported scanner architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    cd /tmp; \
    curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz"; \
    curl -fsSLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt"; \
    grep -F "trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz" "trivy_${TRIVY_VERSION}_checksums.txt" > trivy-selected-checksums.txt; \
    sha256sum -c trivy-selected-checksums.txt; \
    tar -xzf "trivy_${TRIVY_VERSION}_Linux-${TRIVY_ARCH}.tar.gz" trivy; \
    install -m 0755 trivy /usr/local/bin/trivy; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz"; \
    curl -fsSLO "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_checksums.txt"; \
    grep -F "gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" "gitleaks_${GITLEAKS_VERSION}_checksums.txt" > gitleaks-selected-checksums.txt; \
    sha256sum -c gitleaks-selected-checksums.txt; \
    tar -xzf "gitleaks_${GITLEAKS_VERSION}_linux_${GITLEAKS_ARCH}.tar.gz" gitleaks; \
    install -m 0755 gitleaks /usr/local/bin/gitleaks; \
    rm -rf /tmp/trivy* /tmp/gitleaks*

ENV TRIVY_CACHE_DIR=/app/data/cache/trivy

USER node
