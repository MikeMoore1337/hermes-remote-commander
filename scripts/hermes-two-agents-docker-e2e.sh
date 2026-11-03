#!/usr/bin/env bash
set -euo pipefail

image="${1:?Pass the locally built relay image}"
agent_image="${2:?Pass the locally built agent image}"
scripts="$(cd -- "$(dirname -- "$0")" && pwd -P)"
case "$(uname -s)" in
  MINGW*|MSYS*) scripts="$(cygpath -m "$scripts")"; export MSYS_NO_PATHCONV=1 ;;
esac
relay=''
agent_one=''
agent_two=''
cleanup() {
  result=$?
  trap - EXIT
  for container in "$agent_one" "$agent_two" "$relay"; do
    if [[ -n "$container" ]] && ! docker rm -f "$container" >/dev/null; then
      echo 'Failed to remove a test container' >&2
      result=1
    fi
  done
  exit "$result"
}
trap cleanup EXIT

uid="$(docker run --rm --network none --entrypoint id "$agent_image" -u)"
gid="$(docker run --rm --network none --entrypoint id "$agent_image" -g)"
relay="$(docker run -d --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --pids-limit 128 --memory 512m \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  -e HOST=127.0.0.1 -e PUBLIC_URL=http://localhost:3000 -e BRC_DB=/tmp/relay.sqlite \
  -e BRC_ADMIN_USER=ci-owner -e BRC_ADMIN_PASSWORD=synthetic-only-password \
  -e BRC_SESSION_SECRET=synthetic-only-session-secret \
  --mount "type=bind,src=$scripts,dst=/fixtures,readonly" "$image")"
ready=false
for _ in $(seq 1 30); do
  if docker exec "$relay" node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    ready=true
    break
  fi
  [[ "$(docker inspect --format '{{.State.Running}}' "$relay")" == true ]] || { echo 'Test relay exited' >&2; exit 1; }
  sleep 1
done
[[ "$ready" == true ]] || { echo 'Test relay did not start' >&2; exit 1; }
tokens="$(docker exec "$relay" node /fixtures/hermes-two-agents-provision.mjs)"
token_one="$(printf '%s' "$tokens" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).one")"
token_two="$(printf '%s' "$tokens" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).two")"
start_agent() {
  docker run -d --network "container:$relay" --read-only --cap-drop ALL --security-opt no-new-privileges \
    --pids-limit 128 --memory 512m --tmpfs /tmp:rw,nosuid,nodev,size=64m \
    --tmpfs "/workspace:rw,nosuid,nodev,uid=$uid,gid=$gid,mode=0700,size=64m" \
    -e BRC_HOME=/tmp/brc-home -e BRC_RELAY=http://localhost:3000 -e BRC_TOKEN="$2" \
    -e BRC_DEVICE_ID="$1" -e BRC_NAME="$1" -e FIXTURE_CONTENT="$3" \
    --entrypoint sh "$agent_image" -c 'printf "%s\n" "$FIXTURE_CONTENT" > /workspace/identity.txt; exec node /app/dist/cli.js --allow-dir /workspace --no-browser'
}
agent_one="$(start_agent ci-native-one "$token_one" real-ci-agent-one)"
agent_two="$(start_agent ci-native-two "$token_two" real-ci-agent-two)"
docker exec "$relay" node /fixtures/hermes-two-agents-oauth-e2e.mjs
