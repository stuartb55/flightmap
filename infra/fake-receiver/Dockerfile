FROM node:24-alpine@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53

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
