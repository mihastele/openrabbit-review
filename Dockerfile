# ============================================================================
# Stage 1: Lite (Default) — Node.js + git + OpenRabbit built-in AST/heuristic
# ============================================================================
FROM node:22-alpine AS lite

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm ci

COPY tsconfig.json .openrabbit.yaml ./
COPY src ./src
COPY public ./public

RUN npm run build

EXPOSE 3847

ENV NODE_ENV=production
ENV PORT=3847

CMD ["node", "dist/cli/index.js", "serve"]

# ============================================================================
# Stage 2: Full — Batteries-included FOSS Security Scanners (Semgrep, Trivy, Gitleaks)
# ============================================================================
FROM lite AS full

RUN apk add --no-cache python3 py3-pip curl tar \
 && pip3 install --no-cache-dir --break-system-packages semgrep \
 && curl -sSfL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin \
 && GITLEAKS_VER=$(curl -sSf https://api.github.com/repos/gitleaks/gitleaks/releases/latest | grep -o '"tag_name": "v[^"]*"' | head -n1 | cut -d'"' -f4 | sed 's/^v//') \
 && curl -sSfL "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VER}/gitleaks_${GITLEAKS_VER}_linux_x64.tar.gz" | tar -xz -C /usr/local/bin gitleaks
