# Tiny image: just node + our two files, no deps
FROM node:20-alpine

WORKDIR /app

# Copy the proxy + page
COPY server.js ./server.js
COPY index.html ./index.html
COPY logo.png ./logo.png

# config.json is mounted as a read-only volume from the host
# (see docker-compose.yml). Don't bake it into the image.

ENV PORT=5285
ENV CONFIG_PATH=/app/config.json

EXPOSE 5285

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5285/healthz || exit 1

CMD ["node", "server.js"]
