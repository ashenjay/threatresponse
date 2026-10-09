# Lightweight Node monitor. No build step, no native modules.
FROM node:20-alpine

WORKDIR /app

# Install only (optional) production deps. If the registry is unreachable the
# monitor still runs — nodemailer is optional and the core uses no deps.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund || echo "npm install skipped — running with built-in modules only"

# App source
COPY src ./src
COPY public ./public

# Run as the built-in non-root user
USER node

EXPOSE 8080

# Container-level healthcheck hits the monitor's own liveness route.
HEALTHCHECK --interval=60s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENV PORT=8080
CMD ["node", "src/server.js"]
