#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run inside an operator-selected container with pg_dump, tar and api-home
# mounted. The URL stays in the environment and never appears in argv/logs.
usage() {
  echo 'Usage: backup-platform-db.sh --output-dir DIR --api-home DIR [--database-env ENV_NAME]'
}
output_dir=''
api_home=''
database_env='MULTIREMI_DATABASE_URL'
while (($#)); do
  case "$1" in
    --output-dir) output_dir="${2:?missing output directory}"; shift 2;;
    --api-home) api_home="${2:?missing api-home directory}"; shift 2;;
    --database-env) database_env="${2:?missing environment name}"; shift 2;;
    --help|-h) usage; exit 0;;
    *) usage >&2; exit 2;;
  esac
done
[[ -n "$output_dir" && -d "$api_home" ]] || { usage >&2; exit 2; }
[[ "$database_env" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo 'Invalid environment variable name' >&2; exit 2; }
[[ -n "${!database_env:-}" ]] || { echo 'Selected database environment variable is not set' >&2; exit 2; }
command -v pg_dump >/dev/null
command -v pg_restore >/dev/null
command -v tar >/dev/null
command -v sha256sum >/dev/null
mkdir -p "$output_dir"
backup_dir=$(mktemp -d "$output_dir/unified-model-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
# PGDATABASE treats an environment URL as a literal database name. Decode a
# PostgreSQL URI into libpq variables; credentials stay out of process argv.
decode_uri_component() {
  local encoded="$1" byte
  decoded_uri_component=''
  while [[ -n "$encoded" ]]; do
    if [[ "$encoded" == %* ]]; then
      [[ "${encoded:1:2}" =~ ^[[:xdigit:]]{2}$ && "${encoded:1:2}" != 00 ]] || { echo 'Invalid URI encoding' >&2; exit 2; }
      printf -v byte '%b' "\\x${encoded:1:2}"
      decoded_uri_component+="$byte"
      encoded="${encoded:3}"
    else
      decoded_uri_component+="${encoded:0:1}"
      encoded="${encoded:1}"
    fi
  done
}
database_uri="${!database_env}"
[[ "$database_uri" == postgres://* || "$database_uri" == postgresql://* ]] || { echo 'Expected a PostgreSQL URI' >&2; exit 2; }
uri_rest="${database_uri#*://}"
uri_authority="${uri_rest%%/*}"
uri_path="${uri_rest#*/}"
[[ "$uri_rest" != "$uri_path" && "$uri_authority" == *@* ]] || { echo 'Database URI requires host, user and database' >&2; exit 2; }
uri_userinfo="${uri_authority%@*}"
uri_hostport="${uri_authority##*@}"
decode_uri_component "${uri_userinfo%%:*}"; export PGUSER="$decoded_uri_component"
unset PGPASSWORD PGSERVICE PGSERVICEFILE
if [[ "$uri_userinfo" == *:* ]]; then
  decode_uri_component "${uri_userinfo#*:}"; export PGPASSWORD="$decoded_uri_component"
fi
if [[ "$uri_hostport" == \[* ]]; then
  export PGHOST="${uri_hostport#\[}"; PGHOST="${PGHOST%%\]*}"
  uri_port="${uri_hostport#*\]}"; export PGPORT="${uri_port#:}"; PGPORT="${PGPORT:-5432}"
else
  export PGHOST="${uri_hostport%%:*}"
  export PGPORT=5432
  [[ "$uri_hostport" != *:* ]] || PGPORT="${uri_hostport##*:}"
fi
[[ -n "$PGHOST" && "$PGPORT" =~ ^[0-9]+$ ]] || { echo 'Invalid database host or port' >&2; exit 2; }
decode_uri_component "${uri_path%%\?*}"; export PGDATABASE="$decoded_uri_component"
[[ -n "$PGDATABASE" ]] || { echo 'Database name is required' >&2; exit 2; }
if [[ "$uri_path" == *\?* ]]; then
  uri_query="${uri_path#*\?}"
  while [[ -n "$uri_query" ]]; do
    uri_pair="${uri_query%%&*}"; decode_uri_component "${uri_pair#*=}"
    case "${uri_pair%%=*}" in
      sslmode) export PGSSLMODE="$decoded_uri_component";;
      sslrootcert) export PGSSLROOTCERT="$decoded_uri_component";;
      sslcert) export PGSSLCERT="$decoded_uri_component";;
      sslkey) export PGSSLKEY="$decoded_uri_component";;
      connect_timeout) export PGCONNECT_TIMEOUT="$decoded_uri_component";;
      options) export PGOPTIONS="$decoded_uri_component";;
      *) echo 'Unsupported URI query parameter; use a supported libpq URI' >&2; exit 2;;
    esac
    [[ "$uri_query" == *'&'* ]] || break
    uri_query="${uri_query#*&}"
  done
fi
if ! pg_dump --format=custom --file="$backup_dir/platform.pgdump.partial" 2>"$backup_dir/pg-dump-error.private"; then
  echo 'pg_dump failed; private diagnostic retained in backup directory' >&2
  exit 1
fi
pg_restore --list "$backup_dir/platform.pgdump.partial" >"$backup_dir/restore-list.txt"
mv "$backup_dir/platform.pgdump.partial" "$backup_dir/platform.pgdump"
tar -C "$api_home" -czf "$backup_dir/api-home.tar.gz.partial" .
tar -tzf "$backup_dir/api-home.tar.gz.partial" >/dev/null
mv "$backup_dir/api-home.tar.gz.partial" "$backup_dir/api-home.tar.gz"
(cd "$backup_dir" && sha256sum platform.pgdump api-home.tar.gz > SHA256SUMS)
echo "Backup complete: $backup_dir"
