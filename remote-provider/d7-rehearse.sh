#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
d7_image=${D7_IMAGE:-dockmaster-provider-test:local}
d7_image_id=$(docker image inspect "$d7_image" --format '{{.Id}}')
case "$d7_image_id" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "D7 image is not pinned by a local sha256 image ID" >&2; exit 1 ;;
esac

docker run --rm \
  --network=none \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=64 \
  --memory=256m \
  --cpus=0.5 \
  --user=65534:65534 \
  --tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777 \
  --mount "type=bind,src=$script_dir,dst=/work,readonly" \
  --workdir /work \
  --entrypoint /usr/bin/env \
  "$d7_image_id" \
  -i HOME=/tmp PATH=/usr/local/bin:/usr/bin:/bin \
  python -m unittest discover -s test -v
