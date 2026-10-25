#!/bin/bash
# Checks the VM and the settings before a deploy (guide step 8.9, ADR 0045). An error stops the
# deploy; a warning names what the operator has to settle outside this template. deploy.sh runs it
# first; it reads deploy/.env from the environment.
#
#   set -a; . deploy/.env; set +a; bash deploy/scripts/preflight.sh
set -uo pipefail

cd "$(dirname "$0")/.."
errors=0
error() {
  echo "preflight: ERROR $*" >&2
  errors=$((errors + 1))
}
warn() { echo "preflight: warning $*" >&2; }

# --- Tools --------------------------------------------------------------------------------------
for tool in docker openssl curl; do
  command -v "$tool" > /dev/null || error "$tool is missing"
done
docker compose version > /dev/null 2>&1 || error 'the compose plugin of Docker is missing'

# --- Settings -----------------------------------------------------------------------------------
for name in SMP_DOMAIN SMP_MEDIA_DOMAIN SMP_TLS SMP_REGISTRY SMP_VERSION MAIL_FROM SMP_EGRESS_HOSTS; do
  [ -n "${!name:-}" ] || error "$name is not set in deploy/.env"
done
case ${SMP_VERSION:-} in
  latest | '') error 'SMP_VERSION must name a release' ;;
esac
if [ "${SMP_TLS:-}" = internal ] && [ "${SMP_STAGING:-false}" != true ]; then
  error 'SMP_TLS=internal is for a staging only (SMP_STAGING=true)'
fi
if [ -n "${ALERT_SMTP_CA_FILE:-}" ] && [ "${SMP_STAGING:-false}" != true ]; then
  error 'ALERT_SMTP_CA_FILE is for a staging only (compose.staging.yaml mounts the private CA)'
fi

# --- Secrets ------------------------------------------------------------------------------------
required='anthropic_api_key smtp_url'
case ",${SMP_PROFILES:-}," in *,monitoring,*) required="$required alert_smtp_password" ;; esac
case ",${SMP_PROFILES:-}," in
  *,backup,*) required="$required backup_s3_access_key_id backup_s3_secret_access_key" ;;
esac
if [ "${SMP_BILLING:-false}" = true ]; then
  required="$required stripe_secret_key stripe_webhook_secret"
fi
if [ "${SMP_STAGING:-false}" = true ]; then
  required="$required mailpit_tls_key s3_sse_kek"
fi
# The live platforms (ADR 0046).
[ "${PLATFORM_MODE_LINKEDIN:-mock}" = live ] && required="$required linkedin_client_secret"
[ "${PLATFORM_MODE_META:-mock}" = live ] && required="$required meta_app_secret"
if [ "${PLATFORM_MODE_META:-mock}" = live ] && [ -n "${INSTAGRAM_APP_ID:-}" ]; then
  required="$required instagram_app_secret"
fi
[ "${PLATFORM_MODE_X:-mock}" = live ] && required="$required x_client_secret"
for platform in LINKEDIN META X; do
  mode="PLATFORM_MODE_$platform"
  if [ "${!mode:-mock}" = live ] && ! echo ",${SMP_EGRESS_HOSTS:-}," | grep -q ",${SMP_MEDIA_DOMAIN:-none},"; then
    warn "$mode is live: SMP_EGRESS_HOSTS needs the hosts of the platform and SMP_MEDIA_DOMAIN (deploy/.env.example)"
    break
  fi
done
if [ ! -d secrets ] || [ ! -e generated/keyring.env ]; then
  error 'deploy/secrets is missing; run scripts/init-secrets.sh first'
else
  for name in $required; do
    [ -s "secrets/$name" ] || error "secrets/$name is missing or empty (docs/runbooks/deployment.md)"
  done
  # Root and the group 10001 only; never other users.
  loose=$(find secrets -type f -perm /o=rwx -print 2> /dev/null)
  [ -z "$loose" ] || error "secret files readable by others: $(echo "$loose" | tr '\n' ' ')"
  wrong=$(find secrets -maxdepth 1 -type f ! -group 10001 -print 2> /dev/null)
  [ -z "$wrong" ] || error "secret files without the group 10001: $(echo "$wrong" | tr '\n' ' ')"
fi

# --- Internal certificates -------------------------------------------------------------------
for certificate in generated/tls/*.crt; do
  [ -e "$certificate" ] || continue
  if ! openssl x509 -in "$certificate" -noout -checkend $((60 * 86400)) > /dev/null; then
    warn "$certificate ends within 60 days; run scripts/init-secrets.sh --renew-tls"
  fi
done

# --- Time ---------------------------------------------------------------------------------------
# TOTP codes, the expiry of links and the order of the logs depend on a synchronised clock.
if command -v timedatectl > /dev/null && timedatectl show > /dev/null 2>&1; then
  [ "$(timedatectl show -p NTPSynchronized --value)" = yes ] \
    || error 'the clock is not synchronised (timedatectl: NTPSynchronized=no)'
elif [ "${SMP_STAGING:-false}" = true ]; then
  warn 'no timedatectl here; the clock of the host is taken as it is'
else
  error 'cannot tell whether the clock is synchronised (no timedatectl)'
fi

# --- Encrypted disks ----------------------------------------------------------------------------
# The volumes of Postgres, Redis and the storage live below the root directory of Docker.
root_dir=$(docker info --format '{{.DockerRootDir}}' 2> /dev/null || echo /var/lib/docker)
case ${SMP_DISK_ENCRYPTION:-} in
  luks)
    source=$(findmnt -n -o SOURCE --target "$root_dir" 2> /dev/null || true)
    if ! lsblk -s -n -o TYPE "$source" 2> /dev/null | grep -q crypt; then
      error "$root_dir is not on a dm-crypt device ($source)"
    fi
    ;;
  provider) warn "$root_dir is encrypted by the provider of the VM, as SMP_DISK_ENCRYPTION says" ;;
  staging)
    [ "${SMP_STAGING:-false}" = true ] || error 'SMP_DISK_ENCRYPTION=staging is for a staging only'
    warn 'the disks of this staging are not checked for encryption'
    ;;
  *) error 'SMP_DISK_ENCRYPTION must be luks or provider' ;;
esac

# --- Logs ---------------------------------------------------------------------------------------
if [ "${SMP_LOG_DRIVER:-journald}" = journald ]; then
  [ -e /etc/systemd/journald.conf.d/smp.conf ] \
    || error 'journald keeps the logs without the limits of host/journald.conf (copy it to /etc/systemd/journald.conf.d/smp.conf)'
elif [ "${SMP_STAGING:-false}" != true ]; then
  error 'SMP_LOG_DRIVER other than journald is for a staging only'
fi

# --- Names --------------------------------------------------------------------------------------
if [ "${SMP_TLS:-}" != internal ]; then
  for name in "${SMP_DOMAIN:-}" "${SMP_MEDIA_DOMAIN:-}"; do
    [ -z "$name" ] || getent hosts "$name" > /dev/null || error "$name does not resolve"
  done
fi

if [ "$errors" -gt 0 ]; then
  echo "preflight: $errors errors, no deploy" >&2
  exit 1
fi
echo 'preflight: ready'
