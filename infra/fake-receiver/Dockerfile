FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

WORKDIR /opt/fake-receiver
COPY --chown=node:node server.mjs ./

ENV NODE_ENV=production \
    PORT=8081 \
    RECEIVER_LAT=53.61 \
    RECEIVER_LON=-2.31 \
    AIRCRAFT_COUNT=3

USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
