#!/bin/bash
# Creates the secrets and the internal TLS of the production template (guide step 8.9, ADR 0045):
#
#   deploy/secrets/    passwords of the database roles and the Redis users, the URLs every service
#                      connects with, the keys of the app, the access keys of the object storage
#                      and the private keys of the TLS certificates. Root and the group 10001,
#                      which the containers join, may read them; nobody else.
#   deploy/generated/  what is not secret: the certificates with their private CA, the Redis
#                      users with password hashes and the ids of the active keys.
#
# An existing file stays as it is, so the script can run again, for example after a new service
# joined the template. Rotation follows docs/runbooks/secret-rotation.md; --renew-tls issues the
# server certificates anew (the CA stays). Secrets of other parties, such as the key of the Claude
# API, the operator puts into deploy/secrets/ by hand; the script lists those still missing.
#
# Run it as root on the VM: bash deploy/scripts/init-secrets.sh [--renew-tls] [--staging]
set -euo pipefail

cd "$(dirname "$0")/.."
umask 077

readonly SECRET_GID=10001
readonly secrets=secrets generated=generated
renew_tls=false
staging=false
tls_services='postgres redis s3'
for argument in "$@"; do
  case $argument in
    --renew-tls) renew_tls=true ;;
    # A staging on one machine (compose.staging.yaml): the SMTP server Mailpit inside the network,
    # with STARTTLS, and a key of the storage, which encrypts the backups there (SSE-S3).
    --staging)
      staging=true
      tls_services="$tls_services mailpit"
      ;;
    *)
      echo "init-secrets: unknown argument $argument" >&2
      exit 2
      ;;
  esac
done

command -v openssl > /dev/null || { echo 'init-secrets: openssl is missing' >&2; exit 1; }
install -d -m 0750 -o root -g "$SECRET_GID" "$secrets"
install -d -m 0700 -o root -g root "$secrets/ca"
install -d -m 0755 "$generated" "$generated/tls"

created=0
# Writes a secret file once: root:10001, readable by the group only.
put() {
  local name=$1 value=$2
  if [ -e "$secrets/$name" ]; then
    return
  fi
  printf '%s\n' "$value" > "$secrets/$name"
  chown "root:$SECRET_GID" "$secrets/$name"
  chmod 0440 "$secrets/$name"
  created=$((created + 1))
}
read_secret() { tr -d '\n' < "$secrets/$1"; }
# 48 hex characters: no character needs escaping in a URL.
password() { openssl rand -hex 24; }
key() { openssl rand -base64 32; }

# --- Postgres: one login per service and role (deploy/postgres/roles.sh) -----------------------
put postgres_password "$(password)"
for role in app_migrator svc_api svc_api_system svc_scheduler svc_scheduler_system svc_publisher \
  svc_publisher_system svc_media svc_notify svc_billing svc_billing_system svc_backup; do
  put "pg_password_$role" "$(password)"
done
# node-postgres checks the certificate and the host name with verify-full.
database_url() {
  printf 'postgresql://%s:%s@postgres:5432/smp?sslmode=verify-full' "$1" "$(read_secret "pg_password_$1")"
}
for service in api scheduler publisher media notify billing; do
  put "database_url_$service" "$(database_url "svc_$service")"
done
for service in api scheduler publisher billing; do
  put "database_system_url_$service" "$(database_url "svc_${service}_system")"
done
# The schema engine of the prisma CLI names the CA with sslcert and checks it with sslaccept=strict.
put migration_database_url "$(printf 'postgresql://app_migrator:%s@postgres:5432/smp?sslmode=require&sslaccept=strict&sslcert=/run/configs/internal-ca.crt' \
  "$(read_secret pg_password_app_migrator)")"

# --- Redis: one user per service (deploy/redis/users.acl) ---------------------------------------
redis_users='svc-api svc-scheduler svc-publisher svc-media svc-notify svc-billing browser-worker'
for user in $redis_users; do
  put "redis_password_$user" "$(password)"
done
for service in api scheduler publisher media notify billing; do
  put "redis_url_$service" "rediss://svc-$service:$(read_secret "redis_password_svc-$service")@redis:6379"
done
put redis_url_browser_worker "rediss://browser-worker:$(read_secret redis_password_browser-worker)@redis:6379"
# The users with the SHA-256 of their passwords; Redis keeps no password itself.
acl=$(cat redis/users.acl)
for user in $redis_users; do
  hash=$(printf '%s' "$(read_secret "redis_password_$user")" | openssl dgst -sha256 -r | cut -d' ' -f1)
  acl=${acl//@@$user@@/#$hash}
done
put redis_users_acl "$acl"

# --- Object storage: the app and the one-shot init each with their own keys ----------------------
put s3_access_key_id "smp-app-$(openssl rand -hex 8)"
put s3_secret_access_key "$(password)"
put s3_init_access_key_id "smp-init-$(openssl rand -hex 8)"
put s3_init_secret_access_key "$(password)"
put s3_config "$(cat <<JSON
{
  "identities": [
    {
      "name": "app",
      "credentials": [
        { "accessKey": "$(read_secret s3_access_key_id)", "secretKey": "$(read_secret s3_secret_access_key)" }
      ],
      "actions": ["Read:smp-media", "Write:smp-media", "List:smp-media", "Tagging:smp-media"]
    },
    {
      "name": "init",
      "credentials": [
        { "accessKey": "$(read_secret s3_init_access_key_id)", "secretKey": "$(read_secret s3_init_secret_access_key)" }
      ],
      "actions": ["Admin"]
    }
  ]
}
JSON
)"

# The storage of a staging holds the backups as well and encrypts them, as the bucket outside the
# VM does in production (BACKUP_S3_SSE): a key of 256 bits, hex.
if $staging; then
  put s3_sse_kek "$(openssl rand -hex 32)"
fi

# --- Keys of the app (the format of pnpm gen:keys) -------------------------------------------------
put better_auth_secret "$(key)"
for keyring in token session notify; do
  put "${keyring}_keks" "kek-$(openssl rand -hex 4):$(key)"
done
# The ids of the active keys, once. A rotation adds a key first and activates it in this file
# later, with a restart in between (docs/runbooks/secret-rotation.md).
if [ ! -e "$generated/keyring.env" ]; then
  for keyring in token session notify; do
    printf '%s_KEK_ACTIVE=%s\n' "${keyring^^}" "$(read_secret "${keyring}_keks" | cut -d: -f1)"
  done > "$generated/keyring.env"
  chmod 0644 "$generated/keyring.env"
fi

# --- Private CA and the certificates of postgres, redis and s3 ----------------------------------------
if [ ! -e "$secrets/ca/ca.key" ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 3650 \
    -subj '/CN=smp internal CA' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -keyout "$secrets/ca/ca.key" -out "$generated/tls/internal-ca.crt" 2> /dev/null
  chmod 0400 "$secrets/ca/ca.key"
  chmod 0644 "$generated/tls/internal-ca.crt"
fi
for service in $tls_services; do
  if [ -e "$generated/tls/$service.crt" ] && ! $renew_tls; then
    continue
  fi
  rm -f "$secrets/${service}_tls_key"
  work=$(mktemp -d)
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -subj "/CN=$service" \
    -keyout "$work/key" -out "$work/csr" 2> /dev/null
  # The parts of SeaweedFS also sign in to each other with the certificate of s3 (gRPC).
  usage=serverAuth
  [ "$service" = s3 ] && usage=serverAuth,clientAuth
  printf '%s\n' "subjectAltName=DNS:$service,DNS:localhost,IP:127.0.0.1" 'basicConstraints=CA:FALSE' \
    'keyUsage=critical,digitalSignature' "extendedKeyUsage=$usage" > "$work/ext"
  # Two years; deploy.sh warns 60 days before the end, --renew-tls issues new ones.
  openssl x509 -req -in "$work/csr" -CA "$generated/tls/internal-ca.crt" -CAkey "$secrets/ca/ca.key" \
    -CAcreateserial -CAserial "$secrets/ca/ca.srl" -days 730 -extfile "$work/ext" \
    -out "$generated/tls/$service.crt" 2> /dev/null
  chmod 0644 "$generated/tls/$service.crt"
  put "${service}_tls_key" "$(cat "$work/key")"
  rm -rf "$work"
done

echo "init-secrets: $created new secret files in deploy/$secrets"
missing=''
for name in anthropic_api_key smtp_url; do
  [ -e "$secrets/$name" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  echo "init-secrets: still missing, from their providers:$missing" >&2
fi
