FROM node:24-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3

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
