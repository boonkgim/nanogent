FROM node:24-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Plugin dependencies are layered on top by `nanogent build`, which scans
# every plugin folder for an optional install.sh and injects COPY + RUN
# directives in place of the marker below. The generated output is written
# to Dockerfile.generated (gitignored) and that's the file docker-compose
# actually builds from. Edit this base to change the FROM image or the
# baseline apt packages; leave the marker line intact so `nanogent build`
# knows where to splice plugin installs in.
# __NANOGENT_PLUGIN_INSTALLS__

WORKDIR /workspace

CMD ["node", ".nanogent/nanogent.ts"]
