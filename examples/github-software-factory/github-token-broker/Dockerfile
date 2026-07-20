FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

WORKDIR /app
COPY --chown=65532:65532 *.mjs /app/
USER 65532:65532
EXPOSE 8083
ENTRYPOINT ["/nodejs/bin/node", "/app/index.mjs"]
