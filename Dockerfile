FROM node:24-alpine

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/app/data

WORKDIR /app

# --- Layer-Caching: zuerst nur die Manifeste, dann installieren ---
# `npm ci` braucht eine package-lock.json. Falls die Lockfile fehlt, entweder
# lokal einmal `npm install` laufen lassen und die Lockfile committen, oder in
# der naechsten Zeile `npm ci --omit=dev` durch `npm install --omit=dev` ersetzen.
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# --- Rest der App ---
COPY server/ ./server/
COPY public/ ./public/

# Datenverzeichnis (SQLite + Uploads) gehoert dem nicht-root Benutzer `node`,
# der im offiziellen Image bereits existiert.
RUN mkdir -p /app/data/uploads && chown -R node:node /app/data

USER node

EXPOSE 3000

# /api/auth/session ist laut SPEC.md ohne Login erreichbar und liefert immer 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/auth/session').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
