#!/usr/bin/env bash
# Checks the monitoring of guide step 8.7 (ADR 0043) with the images of the compose profile
# "observability": promtool checks the Prometheus configuration with its rules and runs the unit
# tests of the alerts in infra/observability/tests, amtool checks the Alertmanager configuration.
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
