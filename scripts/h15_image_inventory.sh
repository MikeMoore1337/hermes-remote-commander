#!/usr/bin/env bash
# CI-only image provenance and OS/native package inventory. No publish, no host files.
set -euo pipefail
if [ "$#" -ne 3 ]; then
  echo 'usage: h15_image_inventory.sh AGENT_IMAGE RELAY_IMAGE OUTPUT_DIRECTORY' >&2
  exit 2
fi
agent="$1"; relay="$2"; output="$3"
mkdir -p -- "$output"
for pair in "agent:$agent" "relay:$relay"; do
  name="${pair%%:*}"; image="${pair#*:}"
  docker image inspect --format "image_id={{.Id}} os={{.Os}} architecture={{.Architecture}} runtime_user={{.Config.User}}" "$image" > "$output/$name-image.txt"
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
    --entrypoint sh "$image" -c 'test "$(id -u)" -ne 0 && test ! -w /etc && printf "nonroot_readonly=PASS\n"' \
    >> "$output/$name-image.txt"
done

docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint sh "$agent" -c 'dpkg-query -W | LC_ALL=C sort' > "$output/agent-os-packages.tsv"
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint sh "$relay" -c 'apk info -v | LC_ALL=C sort' > "$output/relay-os-packages.txt"
# Do not execute native libraries. Only inspect package.json metadata present in the image.
docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node "$agent" -e '
  const fs = require("node:fs"), path = require("node:path");
  for (const name of ["sharp", "@img/sharp-linux-x64", "@img/sharp-libvips-linux-x64",
    "@img/sharp-linuxmusl-x64", "@img/sharp-libvips-linuxmusl-x64"]) {
    const file = path.resolve("node_modules", name, "package.json");
    if (!fs.existsSync(file)) { console.log(`${name}\tNOT_INSTALLED`); continue; }
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`${name}\t${data.version}\t${data.license || "LICENSE_NOT_DECLARED"}`);
  }
  ' > "$output/agent-native-packages.tsv"
for file in agent-image.txt relay-image.txt agent-os-packages.tsv relay-os-packages.txt agent-native-packages.tsv; do
  test -s "$output/$file" || { echo "inventory_missing=$file" >&2; exit 1; }
done
printf 'H15_IMAGE_INVENTORY=PASS_CI_ONLY\n'
printf 'H15_IMAGE_RELEASE_OR_DEPLOY=NOT_PERFORMED\n'
