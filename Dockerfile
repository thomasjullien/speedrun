# Race Timer - no dependencies, so no install step and no build step.
FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./
COPY public ./public

# The state file and the event log live here. Mount a volume on /app/data,
# otherwise every redeploy starts from an empty race.
RUN mkdir -p /app/data && chown -R node:node /app

ENV NODE_ENV=production \
    PORT=8090

USER node
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8090/healthz || exit 1

CMD ["node", "server.js"]
