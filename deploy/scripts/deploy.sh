#!/bin/bash
# Deploys the release SMP_VERSION of deploy/.env on this VM (guide step 8.9, ADR 0045):
# preflight, the configurations of the monitoring, the signatures of the images, then Compose with
# the jobs db-roles, migrate and s3-init before API and worker, and at the end a check from the
# outside through Caddy. Every step can run again; a failed step stops the deploy.
#
#   sudo bash deploy/scripts/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."
[ -e .env ] || { echo 'deploy: deploy/.env is missing (copy .env.example)' >&2; exit 1; }
set -a
# shellcheck source=/dev/null
. ./.env
set +a

bash scripts/preflight.sh

# The parts of the template this VM runs (compose.yaml, header).
files=(-f compose.yaml)
[ "${SMP_BILLING:-false}" = true ] && files+=(-f compose.billing.yaml)
case ",${SMP_PROFILES:-}," in *,xb,*) files+=(-f compose.xb.yaml) ;; esac
[ "${SMP_STAGING:-false}" = true ] && files+=(-f compose.staging.yaml)
profiles=()
IFS=',' read -r -a wanted <<< "${SMP_PROFILES:-}"
for profile in "${wanted[@]}"; do
  [ -n "$profile" ] && profiles+=(--profile "$profile")
done
compose() { docker compose "${files[@]}" "${profiles[@]}" "$@"; }

case ",${SMP_PROFILES:-}," in
  *,monitoring,*) bash scripts/render-monitoring.sh generated ;;
esac

# The images of a release carry a signature of the release workflow of the repository and an
# attested SBOM (.github/workflows/release.yml). A staging with images built on the machine skips
# the check.
images=$(compose config --images | sort -u)
if [ "${SMP_VERIFY_IMAGES:-true}" = true ]; then
  command -v cosign > /dev/null || { echo 'deploy: cosign is missing' >&2; exit 1; }
  signer=(--certificate-oidc-issuer https://token.actions.githubusercontent.com
    --certificate-identity-regexp '^https://github\.com/v2cause/Social_media_poster/\.github/workflows/release\.yml@refs/tags/v')
  for image in $images; do
    case $image in
      "$SMP_REGISTRY"/*)
        cosign verify "${signer[@]}" "$image" > /dev/null
        cosign verify-attestation --type cyclonedx "${signer[@]}" "$image" > /dev/null
        echo "deploy: signature and SBOM of $image verified"
        ;;
    esac
  done
  compose pull --quiet
else
  echo 'deploy: SMP_VERIFY_IMAGES=false, the signatures of the images are not checked' >&2
fi

# Compose recreates a service when its definition changes, not when a file behind one of its
# configs or secrets does. The hashes of those files, in a label of the services, close the gap:
# a new Caddyfile restarts Caddy, a rotated password the services that read it.
hash_of() { find "$@" -type f -print0 2> /dev/null | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16; }
SMP_HASH_CADDY=$(hash_of caddy generated/tls/internal-ca.crt)
SMP_HASH_STORES=$(hash_of postgres seaweedfs redis generated/tls secrets/postgres_tls_key secrets/redis_tls_key \
  secrets/s3_tls_key secrets/s3_sse_kek secrets/redis_users_acl secrets/s3_config secrets/postgres_password)
SMP_HASH_APP=$(hash_of secrets generated/keyring.env generated/tls/internal-ca.crt)
# Prometheus, Alertmanager and the blackbox exporter read their files at the start only.
SMP_HASH_MONITORING=$(hash_of monitoring ../infra/observability/rules generated/alertmanager.yml \
  generated/blackbox generated/tls/internal-ca.crt secrets/alert_smtp_password)
export SMP_HASH_CADDY SMP_HASH_STORES SMP_HASH_APP SMP_HASH_MONITORING

compose up --detach --wait --remove-orphans

# The blackbox exporter trusts the root of Caddy's own CA in a staging (SMP_TLS internal).
curl_ca=()
if [ "$SMP_TLS" = internal ]; then
  install -d generated/blackbox
  compose cp caddy:/data/caddy/pki/authorities/local/root.crt generated/blackbox/caddy-root.crt > /dev/null
  chmod 0644 generated/blackbox/caddy-root.crt
  curl_ca=(--cacert generated/blackbox/caddy-root.crt)
  case ",${SMP_PROFILES:-}," in *,monitoring,*) compose restart blackbox > /dev/null ;; esac
fi

# From the outside, as a browser: https with HSTS, http redirects, readiness stays inside.
# The check goes to Caddy on this machine, never through a proxy of the environment.
check() {
  curl --silent --show-error --max-time 10 --noproxy '*' --resolve "$SMP_DOMAIN:443:127.0.0.1" \
    --resolve "$SMP_DOMAIN:80:127.0.0.1" "${curl_ca[@]}" "$@"
}
check --fail --output /dev/null "https://$SMP_DOMAIN/api/health/live"
check --head "https://$SMP_DOMAIN/" | grep -qi '^strict-transport-security: max-age=31536000' \
  || { echo 'deploy: HSTS is missing' >&2; exit 1; }
[ "$(check --output /dev/null --write-out '%{http_code}' "http://$SMP_DOMAIN/")" = 308 ] \
  || { echo 'deploy: http does not redirect to https' >&2; exit 1; }
[ "$(check --output /dev/null --write-out '%{http_code}' "https://$SMP_DOMAIN/api/health/ready")" = 404 ] \
  || { echo 'deploy: the readiness check is reachable from outside' >&2; exit 1; }
echo "deploy: $SMP_VERSION runs on https://$SMP_DOMAIN"
