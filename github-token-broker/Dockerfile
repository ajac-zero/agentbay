FROM gcr.io/distroless/nodejs24-debian12:nonroot

WORKDIR /app
COPY --chown=65532:65532 *.mjs /app/

EXPOSE 8083
ENTRYPOINT ["/nodejs/bin/node", "/app/index.mjs"]
