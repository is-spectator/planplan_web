#!/usr/bin/env bash
set -euo pipefail
umask 077

# Host prerequisites are installed explicitly by an operator. This controller
# does not provision a VM, modify DNS, apply migrations, or fetch secrets.
CONFIG_DIR=${PLANPLAN_CONFIG_DIR:-/etc/planplan/beta}
STATE_DIR=${PLANPLAN_STATE_DIR:-/var/lib/planplan-beta-release}
UPSTREAM=${PLANPLAN_UPSTREAM:-/etc/caddy/planplan-beta.upstream}
CADDY_CONFIG=${PLANPLAN_CADDY_CONFIG:-/etc/caddy/Caddyfile}
mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/release.lock"
flock -n 9 || { echo 'Another release is in progress' >&2; exit 1; }
source "$CONFIG_DIR/deploy.env"
: "${PUBLIC_DOMAIN:?Set PUBLIC_DOMAIN}" "${IMAGE_REPOSITORY:?Set IMAGE_REPOSITORY}"
export PUBLIC_DOMAIN
[[ $PUBLIC_DOMAIN =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$ && $PUBLIC_DOMAIN == *.* && $PUBLIC_DOMAIN != *.invalid ]] || { echo 'Configure a real public domain' >&2; exit 1; }
[[ $IMAGE_REPOSITORY =~ ^ghcr.io/[a-z0-9_.-]+/[a-z0-9_.-]+$ ]] || { echo 'Invalid image repository' >&2; exit 1; }
[[ -f "$CONFIG_DIR/runtime.env" && -f "$CONFIG_DIR/secrets/runtime.json" ]] || { echo 'Missing environment configuration or secret mount' >&2; exit 1; }
grep -qx 'DEPLOYMENT_ENV=beta' "$CONFIG_DIR/runtime.env" || { echo 'Refusing a non-beta configuration' >&2; exit 1; }
command=${1:-}
image=${2:-}
current_slot=''; current_image=''
if [[ -f "$STATE_DIR/current" ]]; then read -r current_slot current_image < "$STATE_DIR/current"; fi
if [[ $command == rollback ]]; then
  [[ -z $image && -f "$STATE_DIR/previous" ]] || { echo 'Usage: release.sh rollback (requires previous release)' >&2; exit 1; }
  read -r _ image < "$STATE_DIR/previous"
elif [[ $command != deploy ]]; then
  echo 'Usage: release.sh deploy repository@sha256:digest | rollback' >&2; exit 1
fi
[[ $image == "$IMAGE_REPOSITORY"@sha256:* && ${image##*@sha256:} =~ ^[a-f0-9]{64}$ ]] || { echo 'An immutable digest from the configured repository is required' >&2; exit 1; }
[[ -z $current_slot || $current_slot == blue || $current_slot == green ]] || { echo 'Invalid release state' >&2; exit 1; }
slot=blue; port=18787
if [[ $current_slot == blue ]]; then slot=green; port=18788; fi
name="planplan-beta-$slot"
common=(--read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 128 --memory 768m --cpus 1 --tmpfs /tmp:rw,noexec,nosuid,size=32m --env-file "$CONFIG_DIR/runtime.env" --mount "type=bind,src=$CONFIG_DIR/secrets,dst=/run/secrets,readonly")
docker pull "$image" > /dev/null
# Check exact registry/checksums before stopping anything or switching traffic.
# New migrations must be reviewed and applied in an explicit maintenance step.
docker run --rm "${common[@]}" "$image" migrate-check
docker rm -f "$name" > /dev/null 2>&1 || true
switched=0; success=0
old_fragment="$STATE_DIR/upstream.before"
if [[ -f $UPSTREAM ]]; then cp "$UPSTREAM" "$old_fragment"; else rm -f "$old_fragment"; fi
cleanup() {
  if [[ $success == 0 ]]; then
    if [[ $switched == 1 ]]; then
      if [[ -f $old_fragment ]]; then
        cp "$old_fragment" "$UPSTREAM.tmp"; chmod 644 "$UPSTREAM.tmp"; mv "$UPSTREAM.tmp" "$UPSTREAM"
        if ! caddy reload --config "$CADDY_CONFIG" >/dev/null 2>&1; then
          echo 'Rollback proxy reload failed; operator intervention required' >&2
          return 1
        fi
      else
        # First deployment: return to the deliberately unavailable initial upstream.
        printf 'respond "Unavailable" 503\n' > "$UPSTREAM.tmp"; chmod 644 "$UPSTREAM.tmp"; mv "$UPSTREAM.tmp" "$UPSTREAM"
        caddy reload --config "$CADDY_CONFIG" >/dev/null 2>&1 || true
      fi
    fi
    docker rm -f "$name" > /dev/null 2>&1 || true
    echo 'Candidate rejected; previous release state preserved' >&2
  fi
}
trap cleanup EXIT
docker run -d --name "$name" --restart unless-stopped -p "127.0.0.1:$port:8787" "${common[@]}" -e "RELEASE_ID=$image" "$image" serve > /dev/null
healthy=0
for _ in $(seq 1 20); do
  if curl --silent --fail --max-time 3 "http://127.0.0.1:$port/readyz" | jq -e --arg expected "$image" '.ok == true and .release == $expected' > /dev/null; then healthy=1; break; fi
  sleep 2
done
[[ $healthy == 1 ]] || { echo 'Candidate readiness failed' >&2; exit 1; }
printf 'reverse_proxy 127.0.0.1:%s {\n    header_up X-Real-IP {remote_host}\n}\n' "$port" > "$UPSTREAM.tmp"
chmod 644 "$UPSTREAM.tmp"
mv "$UPSTREAM.tmp" "$UPSTREAM"
switched=1
PUBLIC_DOMAIN="$PUBLIC_DOMAIN" caddy validate --config "$CADDY_CONFIG" > /dev/null 2>&1
PUBLIC_DOMAIN="$PUBLIC_DOMAIN" caddy reload --config "$CADDY_CONFIG" > /dev/null 2>&1
# Do not route authenticated probe data through the CDN. This is just readiness.
curl --silent --fail --max-time 10 -H 'Cache-Control: no-cache' "https://$PUBLIC_DOMAIN/readyz" | jq -e --arg expected "$image" '.ok == true and .release == $expected' > /dev/null
if [[ -n $current_slot ]]; then printf '%s %s\n' "$current_slot" "$current_image" > "$STATE_DIR/previous.tmp"; mv "$STATE_DIR/previous.tmp" "$STATE_DIR/previous"; fi
printf '%s %s\n' "$slot" "$image" > "$STATE_DIR/current.tmp"
mv "$STATE_DIR/current.tmp" "$STATE_DIR/current"
success=1
# Preserve the previous image digest, but stop its process after successful switch.
if [[ -n $current_slot ]]; then docker stop --time 30 "planplan-beta-$current_slot" > /dev/null; fi
echo "Beta release $command completed"
