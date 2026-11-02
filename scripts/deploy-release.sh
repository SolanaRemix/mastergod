#!/usr/bin/env bash
set -euo pipefail

require_value() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'Deployment BLOCKED: required configuration %s is missing.\n' "$name" >&2
    exit 2
  fi
}

for name in GODS_DEPLOY_HOST GODS_DEPLOY_USER GODS_DEPLOY_KEY GODS_DEPLOY_KNOWN_HOSTS GODS_DEPLOY_PATH GODS_DEPLOY_HEALTH_URL; do
  require_value "$name"
done

if [[ ! "$GODS_DEPLOY_HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
  || [[ ! "$GODS_DEPLOY_USER" =~ ^[A-Za-z_][A-Za-z0-9_-]*$ ]] \
  || [[ ! "$GODS_DEPLOY_PATH" =~ ^/[A-Za-z0-9._/-]+$ ]] \
  || [[ "/$GODS_DEPLOY_PATH/" == *"/../"* ]] \
  || [[ "$GODS_DEPLOY_PATH" == "/" ]] \
  || ! node -e 'try { const url = new URL(process.argv[1]); if (url.protocol !== "https:" || !url.hostname || url.username || url.password) process.exit(1) } catch { process.exit(1) }' "$GODS_DEPLOY_HEALTH_URL"; then
  printf 'Deployment BLOCKED: host, user, path, or HTTPS health URL is invalid.\n' >&2
  exit 2
fi

if [[ "${1:-}" == "preflight" ]]; then
  node <<'NODE'
const fs = require("node:fs");
let blueprint;
try {
  blueprint = JSON.parse(fs.readFileSync("gods.blueprint.yaml", "utf8"));
} catch {
  console.error("Deployment BLOCKED: the release blueprint could not be verified.");
  process.exit(3);
}
if (blueprint.release?.productionReady !== true) {
  console.error("Deployment BLOCKED: the project release blueprint still has unmet production gates.");
  process.exit(3);
}
console.log("Production gates are marked ready; deployment remains protected by environment approval.");
NODE
  exit 0
fi

revision="${GITHUB_SHA:-}"
if [[ ! "$revision" =~ ^[a-f0-9]{40,64}$ ]]; then
  printf 'Deployment BLOCKED: GITHUB_SHA is not a full commit SHA.\n' >&2
  exit 2
fi

archive="$(find dist -maxdepth 1 -type f -name "master-gods-*-${revision:0:12}.tar.gz" -print -quit)"
if [[ -z "$archive" ]]; then
  printf 'Deployment BLOCKED: the verified release artifact is missing.\n' >&2
  exit 2
fi

command -v ssh >/dev/null
command -v scp >/dev/null
command -v curl >/dev/null
umask 077
ssh_directory="$(mktemp -d)"
trap 'rm -rf "$ssh_directory"' EXIT
printf '%s\n' "$GODS_DEPLOY_KEY" > "$ssh_directory/key"
printf '%s\n' "$GODS_DEPLOY_KNOWN_HOSTS" > "$ssh_directory/known_hosts"
chmod 600 "$ssh_directory/key" "$ssh_directory/known_hosts"
target="$GODS_DEPLOY_USER@$GODS_DEPLOY_HOST"
ssh_options=(-i "$ssh_directory/key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$ssh_directory/known_hosts")

ssh "${ssh_options[@]}" "$target" mkdir -p -- "$GODS_DEPLOY_PATH"
scp "${ssh_options[@]}" "$archive" "$target:$GODS_DEPLOY_PATH/$revision.tar.gz"
ssh "${ssh_options[@]}" "$target" bash -s -- "$GODS_DEPLOY_PATH" "$revision" deploy <<'REMOTE'
set -euo pipefail
base="$1"
revision="$2"
operation="$3"
[[ "$base" =~ ^/[A-Za-z0-9._/-]+$ && ! "/$base/" == *"/../"* ]]
[[ "$revision" =~ ^[a-f0-9]{40,64}$ ]]
release="$base/releases/$revision"
rollback_file="$base/.rollback-$revision"

restore_previous() {
  previous="$(cat "$rollback_file" 2>/dev/null || true)"
  if [[ -n "$previous" ]]; then
    ln -sfn "$previous" "$base/current.next"
    mv -Tf "$base/current.next" "$base/current"
    sudo systemctl restart gods.service
  else
    rm -f "$base/current" "$base/current.next"
    sudo systemctl stop gods.service || true
  fi
  rm -f "$rollback_file"
}

if [[ "$operation" == "deploy" ]]; then
  mkdir -p "$base/releases" "$release"
  previous="$(readlink "$base/current" 2>/dev/null || true)"
  printf '%s' "$previous" > "$rollback_file"
  tar -xzf "$base/$revision.tar.gz" -C "$release"
  ln -sfn "$release" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
  rm -f "$base/$revision.tar.gz"
  if ! sudo systemctl restart gods.service; then
    restore_previous
    exit 1
  fi
elif [[ "$operation" == "rollback" ]]; then
  restore_previous
else
  exit 2
fi
REMOTE

health_verified=false
if curl --proto '=https' --fail --silent --show-error --max-time 15 --retry 3 --retry-delay 2 \
 --output "$ssh_directory/health.json" "$GODS_DEPLOY_HEALTH_URL"; then
 if node - "$ssh_directory/health.json" <<'NODE'
const fs = require("node:fs");
try {
 const health = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
 if (health.status !== "VERIFIED"
   || health.application !== "available"
   || health.persistence !== "sqlite"
   || health.productionReady !== true) process.exit(1);
} catch {
 process.exit(1);
}
NODE
 then
   health_verified=true
 fi
fi

if [[ "$health_verified" != true ]]; then
 printf 'Deployment health verification failed; requesting rollback.\n' >&2
  ssh "${ssh_options[@]}" "$target" bash -s -- "$GODS_DEPLOY_PATH" "$revision" rollback <<'REMOTE'
set -euo pipefail
base="$1"
revision="$2"
[[ "$base" =~ ^/[A-Za-z0-9._/-]+$ && ! "/$base/" == *"/../"* ]]
[[ "$revision" =~ ^[a-f0-9]{40,64}$ ]]
rollback_file="$base/.rollback-$revision"
previous="$(cat "$rollback_file" 2>/dev/null || true)"
if [[ -n "$previous" ]]; then
  ln -sfn "$previous" "$base/current.next"
  mv -Tf "$base/current.next" "$base/current"
  sudo systemctl restart gods.service
else
  rm -f "$base/current" "$base/current.next"
  sudo systemctl stop gods.service || true
fi
rm -f "$rollback_file"
REMOTE
  exit 1
fi

printf 'Deployment VERIFIED: the application and persistence passed the HTTPS production-readiness health check for commit %s.\n' "$revision"
