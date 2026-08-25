FROM mcr.microsoft.com/playwright:v1.53.0-noble

WORKDIR /app
ENV NODE_ENV=production
ENV MINUTE_DATA_DIR=/app/.data

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json minute.config.yaml slack-manifest.json ./
COPY src ./src
COPY scripts ./scripts

RUN mkdir -p /app/.data && chown -R pwuser:pwuser /app
USER pwuser

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "src/index.ts"]
