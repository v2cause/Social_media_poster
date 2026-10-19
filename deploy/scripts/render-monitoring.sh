#!/bin/bash
# Writes the configurations of the monitoring that depend on deploy/.env (guide step 8.9, ADR
# 0045): the modules of the blackbox exporter for both names, and Alertmanager with the SMTP
# account of the operator and the routes of infra/observability/alertmanager.yml. deploy.sh runs
# it with the settings of the VM; tools/observability/check-rules.sh with those of
# deploy/.env.example, and checks the result.
#
#   bash deploy/scripts/render-monitoring.sh [output directory, default deploy/generated]
set -euo pipefail

cd "$(dirname "$0")/.."
out=${1:-generated}
: "${SMP_DOMAIN:?}" "${SMP_MEDIA_DOMAIN:?}" "${SMP_TLS:?}"
: "${ALERT_SMTP_SMARTHOST:?}" "${ALERT_SMTP_USER:?}" "${ALERT_FROM:?}" "${ALERT_TO:?}"

# The values end up in YAML; names, addresses and host:port need no quoting.
plain='^[A-Za-z0-9._@:+-]+$'
for name in SMP_DOMAIN SMP_MEDIA_DOMAIN ALERT_SMTP_SMARTHOST ALERT_SMTP_USER ALERT_FROM ALERT_TO; do
  if ! [[ ${!name} =~ $plain ]]; then
    echo "render-monitoring: $name has characters other than letters, digits and ._@:+-" >&2
    exit 1
  fi
done

mkdir -p "$out/blackbox"
ca_file='' internal=''
if [ "$SMP_TLS" = internal ]; then
  # The root of Caddy's own CA, which deploy.sh copies next to the configuration.
  ca_file='ca_file: /etc/blackbox/caddy-root.crt'
  internal=1
fi
cat > "$out/blackbox/blackbox.yml" <<YAML
# Written by deploy/scripts/render-monitoring.sh from deploy/.env.
modules:
  app:
    prober: http
    timeout: 10s
    http:
      headers:
        Host: $SMP_DOMAIN
      fail_if_not_ssl: true
      tls_config:
        server_name: $SMP_DOMAIN
        $ca_file
  media:
    prober: tcp
    timeout: 10s
    tcp:
      tls: true
      tls_config:
        server_name: $SMP_MEDIA_DOMAIN
        $ca_file
YAML

if [ -n "${ALERT_SMTP_CA_FILE:-}" ] && ! [[ $ALERT_SMTP_CA_FILE =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo 'render-monitoring: ALERT_SMTP_CA_FILE must be a plain path' >&2
  exit 1
fi
{
  cat <<YAML
# Written by deploy/scripts/render-monitoring.sh from deploy/.env and the routes of
# infra/observability/alertmanager.yml (ADR 0043).
global:
  smtp_smarthost: $ALERT_SMTP_SMARTHOST
  smtp_from: $ALERT_FROM
  smtp_auth_username: $ALERT_SMTP_USER
  smtp_auth_password_file: /run/secrets/alert_smtp_password
  smtp_require_tls: true

YAML
  # The receiver mails ALERT_TO; ALERT_SMTP_CA_FILE names the private CA of a mail server in a
  # staging. Caddy's own CA (SMP_TLS internal) issues certificates for 12 hours and renews them by
  # itself, so their end is no alarm there; TlsProbeFailing still fires when a renewal fails.
  sed -n '/^route:/,$p' ../infra/observability/alertmanager.yml \
    | awk -v to="$ALERT_TO" -v ca="${ALERT_SMTP_CA_FILE:-}" -v internal="$internal" '
      $0 == "      - to: operations@smp.test" {
        print "      - to: " to
        if (ca != "") { print "        tls_config:"; print "          ca_file: " ca }
        next
      }
      $0 == "  routes:" && internal {
        print
        print "    - matchers: [\x27alertname=~\"TlsCertificateExpires.*\"\x27]"
        print "      receiver: quiet"
        next
      }
      $0 == "receivers:" && internal { print; print "  - name: quiet"; next }
      { print }'
} > "$out/alertmanager.yml.new"
# The receiver of the local profile must not survive, and the quiet one must exist with Caddy's
# own CA: otherwise a line they match has changed.
if grep -q 'operations@smp\.test' "$out/alertmanager.yml.new" \
  || { [ -n "$internal" ] && [ "$(grep -c -E '^ +(receiver|- name): quiet$' "$out/alertmanager.yml.new")" != 2 ]; }; then
  rm "$out/alertmanager.yml.new"
  echo 'render-monitoring: infra/observability/alertmanager.yml changed; adapt this script' >&2
  exit 1
fi
mv "$out/alertmanager.yml.new" "$out/alertmanager.yml"
echo "render-monitoring: $out/blackbox/blackbox.yml and $out/alertmanager.yml written"
