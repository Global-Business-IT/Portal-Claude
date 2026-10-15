# --- build del frontend ---
FROM node:22-bookworm-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- servidor ---
FROM node:22-bookworm-slim
# git: sincronizar skills. bubblewrap/socat: aislamiento para skills con scripts (solo si el admin las permite).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 python3-venv bubblewrap socat \
    && rm -rf /var/lib/apt/lists/*
# MarkItDown (Microsoft): convierte los adjuntos (PDF, Word, Excel, PowerPoint...) a Markdown.
RUN python3 -m venv /opt/markitdown \
    && /opt/markitdown/bin/pip install --no-cache-dir 'markitdown[pdf,docx,pptx,xlsx,xls]==0.1.8'
ENV MARKITDOWN_BIN=/opt/markitdown/bin/markitdown
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=web /app/web/dist /app/web/dist
RUN mkdir -p /app/server/data && chown -R node:node /app
USER node
EXPOSE 3000
VOLUME ["/app/server/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/me').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
