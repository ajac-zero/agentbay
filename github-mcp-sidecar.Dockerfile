FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a

WORKDIR /app

# The sidecar is dependency-free Node ESM. Keep source, tests, and the rest of
# the agentbay repository out of the runtime image.
COPY --chown=65532:65532 github-mcp-sidecar/*.mjs /app/

USER 65532:65532
EXPOSE 8082

ENTRYPOINT ["/nodejs/bin/node", "/app/server.mjs"]
