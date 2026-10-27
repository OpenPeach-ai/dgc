# DGC's Pips runner on a server, with no VS Code and no desktop (deploy/docker/README.md).
#
# Debian slim with Python 3.12; DGC installed from its release archive by install.sh, at the version you pin; the
# Python SDK; bubblewrap. DGC's state, settings and secrets live on the /data volume. The container runs
# `dgc pips serve --server`, and Docker's health check is `dgc pips health`.
#
# Build from the repository root, at the tag of the release you install:
#
#   docker build -f deploy/docker/Dockerfile --build-arg DGC_VERSION=0.48.4 -t dgc-pips .
#
# or from a release archive you built yourself (scripts/build-release.sh writes dist/release):
#
#   docker build -f deploy/docker/Dockerfile --build-arg DGC_VERSION=0.48.4 \
#     --build-context release=dist/release -t dgc-pips .

ARG PYTHON_IMAGE=python:3.12-slim

# Empty, unless --build-context release=DIR names a folder holding dgc.tar.gz and dgc.tar.gz.sha256.
FROM scratch AS release

FROM ${PYTHON_IMAGE}

# The DGC release to install, for example 0.48.4. install.sh refuses any other version.
ARG DGC_VERSION
# Where install.sh downloads the release from, when no release context is given.
ARG DGC_BASE_URL=https://vibedgc.com
# Empty: the Python SDK from this checkout (sdk/python). Or a version, for example 0.7.0, to install dgc-sdk from PyPI.
ARG DGC_SDK_VERSION=
ARG DGC_UID=10001

ENV LANG=C.UTF-8 \
    PYTHONUNBUFFERED=1 \
    PIP_ROOT_USER_ACTION=ignore \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# tini reaps the children Pips' runs leave and passes Docker's stop on. bubblewrap boxes Pip computers and reviewed
# commands where the container allows user namespaces (README, "Without bubblewrap"); git is for project Pips.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl git tini \
 && rm -rf /var/lib/apt/lists/*

COPY install.sh /tmp/dgc-install/install.sh
COPY --from=release / /tmp/dgc-install/release/
RUN set -eu; \
    if [ -z "${DGC_VERSION}" ]; then echo "Choose the DGC release: --build-arg DGC_VERSION=X.Y.Z" >&2; exit 1; fi; \
    base="${DGC_BASE_URL}"; \
    if [ -f /tmp/dgc-install/release/dgc.tar.gz ]; then base=file:///tmp/dgc-install/release; fi; \
    DGC_BASE_URL="$base" DGC_INSTALL_VERSION="${DGC_VERSION}" DGC_SKIP_EXTENSION=1 \
      DGC_DATA_DIR=/opt/dgc DGC_BIN=/usr/local/bin DGC_PYTHON=/usr/local/bin/python3 \
      bash /tmp/dgc-install/install.sh; \
    rm -rf /tmp/dgc-install /root/.cache; \
    test "$(dgc --version)" = "dgc ${DGC_VERSION}"

COPY sdk/python /tmp/dgc-sdk
RUN set -eu; \
    if [ -n "${DGC_SDK_VERSION}" ]; then pip install "dgc-sdk==${DGC_SDK_VERSION}"; else pip install /tmp/dgc-sdk; fi; \
    rm -rf /tmp/dgc-sdk /root/.cache; \
    python3 -c "import dgc_sdk"

COPY deploy/docker/with-pips /usr/local/bin/with-pips

# One user owns DGC's home. Run your app as this same user (README): Pips state is readable by its owner only.
RUN useradd --uid "${DGC_UID}" --home-dir /data --no-create-home --shell /usr/sbin/nologin dgc \
 && mkdir -p /data && chown dgc:dgc /data && chmod 0700 /data \
 && chmod 0755 /usr/local/bin/with-pips

# DGC's home, and so its settings, secrets and Pips state, is the volume.
ENV DGC_HOME=/data \
    HOME=/data
USER dgc
WORKDIR /data
VOLUME ["/data"]

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["dgc", "pips", "health"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["dgc", "pips", "serve", "--server"]
