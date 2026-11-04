#!/usr/bin/env bash
# Synthetic-only compatibility smoke: exact fork image + legacy-style UID/state.
# No production relay, owner credentials, persistent volumes, or exposed ports.
set -euo pipefail

if [[ "$#" -ne 1 || "$1" != 'brc/relay:ci' ]]; then
  echo 'H454_SMOKE_IMAGE_NOT_ALLOWED' >&2
  exit 2
fi
image="$1"
cid=''
cleanup() {
  local status=$?
  trap - EXIT
  if [[ -n "$cid" ]]; then docker rm -f "$cid" >/dev/null 2>&1 || true; fi
  exit "$status"
}
trap cleanup EXIT

cid="$(docker run -d --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 80 --memory 512m --cpus 0.5 \
  --user 979:975 --tmpfs '/state:rw,nosuid,nodev,uid=979,gid=975,mode=0700,size=16m' \
  --tmpfs '/tmp:rw,nosuid,nodev,noexec,uid=979,gid=975,mode=0700,size=16m' \
  -e HOME=/tmp -e HOST=127.0.0.1 -e PORT=3000 \
  -e BRC_DB=/state/relay.sqlite -e PUBLIC_URL=http://127.0.0.1:3000 \
  -e BRC_ADMIN_USER=offline-owner -e BRC_ADMIN_PASSWORD=synthetic-ci-only \
  -e BRC_SESSION_SECRET=synthetic-ci-session-only "$image")"

ready=0
for _ in $(seq 1 30); do
  if docker exec "$cid" node -e '
    fetch("http://127.0.0.1:3000/health")
      .then(async r => {
        const body = await r.json();
        if (!r.ok || body.ok !== true || body.devices !== 0) process.exit(1);
      })
      .catch(() => process.exit(1))
  ' >/dev/null 2>&1; then ready=1; break; fi
  [[ "$(docker inspect --format '{{.State.Running}}' "$cid")" == 'true' ]] || {
    echo 'H454_FORK_RELAY_EXITED' >&2; exit 1;
  }
  sleep 1
done
[[ "$ready" -eq 1 ]] || { echo 'H454_FORK_RELAY_HEALTH_TIMEOUT' >&2; exit 1; }

docker exec "$cid" node -e '
  const fs = require("node:fs");
  const state = fs.statSync("/state/relay.sqlite");
  if (process.getuid() !== 979 || process.getgid() !== 975 ||
      state.uid !== 979 || state.gid !== 975 ||
      fs.existsSync("/data/relay.sqlite") ||
      process.env.BRC_DB !== "/state/relay.sqlite") process.exit(1);
'
contract="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}} {{.HostConfig.NetworkMode}}' "$cid")"
[[ "$contract" == 'true false none' ]] || {
  echo 'H454_FORK_CONTAINER_BOUNDARY_INVALID' >&2; exit 1;
}
echo 'H454_FORK_LEGACY_UID_AND_STATE_MOUNT=PASS_SYNTHETIC_ONLY'
echo 'H454_OWNER_RELAY_OR_TOKENS_CHANGED=NO'
echo 'H454_CUTOVER_COMPATIBILITY=NOT_VERIFIED'
