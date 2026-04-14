#!/usr/bin/env bash
# claude tool — container-side dependency installer.
#
# `nanogent build` scans every plugin directory for an install.sh file and,
# when it finds one, splices `COPY <path>/install.sh ...` + `RUN bash ...`
# directives into the generated Dockerfile. That means this script runs at
# `docker compose up --build` time, inside the image being built, as root.
#
# The claude tool shells out to the `claude` CLI at runtime (see index.ts),
# so the CLI has to exist on PATH inside the container. That's the only
# reason this file exists — remove the plugin folder and the dependency
# disappears from the image on the next `nanogent build`.
set -euo pipefail

npm install -g @anthropic-ai/claude-code
