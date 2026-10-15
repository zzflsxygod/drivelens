# syntax=docker/dockerfile:1.7
# Multi-arch build (linux/amd64, linux/arm64). Cross-compiles natively on the build host
# with tonistiigi/xx instead of emulating the whole Rust build under QEMU (much faster).
FROM --platform=$BUILDPLATFORM tonistiigi/xx:1.6.1 AS xx

FROM --platform=$BUILDPLATFORM rust:1-bookworm AS builder
COPY --from=xx / /
ARG TARGETPLATFORM
RUN apt-get update && apt-get install -y --no-install-recommends clang lld && rm -rf /var/lib/apt/lists/*
RUN xx-apt-get update && xx-apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# Cache dependencies
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs && \
    xx-cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && xx-cargo build --release --locked && \
    cp target/$(xx-cargo --print-target-triple)/release/drivelens-api /drivelens-api && \
    xx-verify /drivelens-api

# Small runtime: glibc + CA certs, no shell, runs as uid 65532 (nonroot)
FROM gcr.io/distroless/cc-debian12:nonroot
COPY --from=builder /drivelens-api /usr/local/bin/drivelens-api
ENV BIND_ADDR=0.0.0.0:8080 RUST_LOG=info
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/drivelens-api"]
