# ==============================================================================
# smoothcomp-scrubber-ui
# Web UI wrapper around smoothcomp-scrubber.
# Builds on top of the scrubber base image — expects local/scrubber to exist.
# ==============================================================================

FROM local/scrubber

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Install web dependencies into the same pipenv
RUN pipenv install fastapi uvicorn[standard]

# Copy the web app
COPY app /app

# Volumes
RUN mkdir -p /videos /outputs /config
VOLUME ["/videos", "/outputs", "/config"]

ENV VIDEOS_DIR=/videos
ENV OUTPUTS_DIR=/outputs
ENV CONFIG_DIR=/config

EXPOSE 8080

CMD ["pipenv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
