FROM node:24-alpine@sha256:44fce696f38ba8c987c4db89954051000bbd05ffd8d8659ba15ed4a8602e937f

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
