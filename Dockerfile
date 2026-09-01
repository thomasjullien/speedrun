# Race Timer - no dependencies, so no install step and no build step.
FROM node:22-alpine

WORKDIR /app

COPY package.json server.js ./
COPY public ./public

# The state file and the event log live here. Mount a volume on /app/data,
# otherwise every redeploy starts from an empty race.
RUN mkdir -p /app/data

ENV NODE_ENV=production \
    PORT=8090

EXPOSE 8090

# Deliberately no USER and no HEALTHCHECK.
#
# USER node looks tidier, but a volume created by an earlier root container
# then becomes unwritable and the app silently stops saving times - a failure
# you would only discover after a race.
#
# HEALTHCHECK is worse here: under Docker Swarm a task that never reports
# healthy is never promoted, so the old container keeps serving, the new one
# never appears, and the deployment looks like it simply did nothing.
# The orchestrator's own restart policy covers the failure case.

CMD ["node", "server.js"]
