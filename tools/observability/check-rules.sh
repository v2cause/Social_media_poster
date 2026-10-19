#!/usr/bin/env bash
# Checks the monitoring of guide step 8.7 (ADR 0043) with the images of the compose profile
# "observability": promtool checks the Prometheus configuration with its rules and runs the unit
# tests of the alerts in infra/observability/tests, amtool checks the Alertmanager configuration.
# The same for the monitoring of the production template in deploy/ (guide step 8.9).
#
# Run from anywhere, with Docker: pnpm check:alerts
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR="$ROOT/infra/observability"

# The versions live in compose.yaml only.
image_of() {
  local image
  image=$(sed -n "s|^ *image: \(prom/$1:[^ ]*\)$|\1|p" "$ROOT/compose.yaml")
  if [ -z "$image" ]; then
    echo "check-rules: compose.yaml names no image prom/$1" >&2
    exit 1
  fi
  echo "$image"
}
PROMETHEUS_IMAGE=$(image_of prometheus)
ALERTMANAGER_IMAGE=$(image_of alertmanager)

docker run --rm -v "$DIR:/etc/prometheus:ro" --entrypoint promtool "$PROMETHEUS_IMAGE" \
  check config /etc/prometheus/prometheus.yml
docker run --rm -v "$DIR:/etc/prometheus:ro" --entrypoint promtool "$PROMETHEUS_IMAGE" \
  test rules /etc/prometheus/tests/alerts.test.yml
docker run --rm -v "$DIR/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
  --entrypoint amtool "$ALERTMANAGER_IMAGE" check-config /etc/alertmanager/alertmanager.yml

# The monitoring of the production template (guide step 8.9, ADR 0045): its Prometheus with the
# rules of both directories, the tests of the certificate alerts, and Alertmanager and the
# blackbox exporter as render-monitoring.sh writes them for the settings of deploy/.env.example.
DEPLOY="$ROOT/deploy"
BLACKBOX_IMAGE=$(sed -n "s|^ *image: \(prom/blackbox-exporter:[^ ]*\)$|\1|p" "$DEPLOY/compose.yaml")
docker run --rm -v "$DEPLOY/monitoring/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$DIR/rules:/etc/prometheus/rules:ro" -v "$DEPLOY/monitoring/rules:/etc/prometheus/deploy-rules:ro" \
  --entrypoint promtool "$PROMETHEUS_IMAGE" check config /etc/prometheus/prometheus.yml
docker run --rm -v "$DEPLOY/monitoring:/etc/prometheus:ro" --entrypoint promtool "$PROMETHEUS_IMAGE" \
  test rules /etc/prometheus/tests/tls.test.yml
rendered=$(mktemp -d)
trap 'rm -rf "$rendered"' EXIT
# Renders into $1 with the settings of deploy/.env.example and the ones after it (NAME=value).
render() {
  local dir=$1
  shift
  (
    set -a
    # shellcheck source=/dev/null
    . "$DEPLOY/.env.example"
    [ "$#" -eq 0 ] || export "$@"
    set +a
    bash "$DEPLOY/scripts/render-monitoring.sh" "$dir" > /dev/null
  )
  chmod -R a+rX "$dir"
}
# Fails unless Alertmanager of $1 sends an alert with the labels after it to the receiver $2.
route() {
  local dir=$1 receiver=$2
  shift 2
  docker run --rm -v "$dir/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    --entrypoint amtool "$ALERTMANAGER_IMAGE" config routes test \
    --config.file=/etc/alertmanager/alertmanager.yml --verify.receivers="$receiver" "$@" > /dev/null
}
# A VM with certificates of a public CA, and a staging with those of Caddy's own CA.
render "$rendered/public"
render "$rendered/internal" SMP_TLS=internal
for variant in public internal; do
  docker run --rm -v "$rendered/$variant/alertmanager.yml:/etc/alertmanager/alertmanager.yml:ro" \
    --entrypoint amtool "$ALERTMANAGER_IMAGE" check-config /etc/alertmanager/alertmanager.yml > /dev/null
  docker run --rm -v "$rendered/$variant/blackbox:/etc/blackbox:ro" "$BLACKBOX_IMAGE" \
    --config.file=/etc/blackbox/blackbox.yml --config.check
done
# The end of a certificate reaches the operator; Caddy renews its own ones every 12 hours, so
# there only a failing probe does.
route "$rendered/public" operations alertname=TlsCertificateExpiresSoon severity=ticket
route "$rendered/public" operations alertname=TlsCertificateExpiresVerySoon severity=page
route "$rendered/internal" quiet alertname=TlsCertificateExpiresSoon severity=ticket
route "$rendered/internal" quiet alertname=TlsCertificateExpiresVerySoon severity=page
route "$rendered/internal" operations alertname=TlsProbeFailing severity=page
echo 'check-rules: the routes of the production template are as expected'
