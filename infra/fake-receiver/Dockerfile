FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

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
