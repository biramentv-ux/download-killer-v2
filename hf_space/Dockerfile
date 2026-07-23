FROM node:22-bookworm-slim

ENV PORT=7860 \
    NODE_ENV=production \
    HF_BACKEND_MODE=free-public \
    HF_LOCAL_DOWNLOADER_ENABLED=1 \
    HF_LOCAL_DOWNLOADER_PORT=8081 \
    PUBLIC_BASE_URL=https://dyrakarmy-dyrakarmy-platform.hf.space \
    WRANGLER_SEND_METRICS=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      ffmpeg \
      python3 \
      python3-venv \
      tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY worker/package.json worker/package-lock.json ./worker/
RUN cd worker \
    && npm ci --include=dev \
    && npm cache clean --force

COPY downloader/requirements.txt ./downloader/requirements.txt
RUN python3 -m venv /opt/dyrakarmy-downloader \
    && /opt/dyrakarmy-downloader/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/dyrakarmy-downloader/bin/pip install --no-cache-dir -r /app/downloader/requirements.txt

COPY worker ./worker
COPY downloader ./downloader
COPY start.sh import-cloudflare-state.sh render-dev-vars.mjs standalone-preflight.mjs standalone-supervisor.mjs ./hf/

RUN chmod +x /app/hf/start.sh /app/hf/import-cloudflare-state.sh \
    && chown -R 1000:1000 /app /opt/dyrakarmy-downloader

USER 1000

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=5 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/hf-runtime/health" >/dev/null || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/hf/start.sh"]
