#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=versions.env
source "${SCRIPT_DIR}/versions.env"

SECRETS_DIR="${ZADIG_ROOT}/secrets"
ADMIN_PASSWORD_FILE="${SECRETS_DIR}/admin-password"
ADMIN_API_TOKEN_FILE="${SECRETS_DIR}/admin-api-token"
QA_PASSWORD_FILE="${SECRETS_DIR}/qa-password"
QA_API_TOKEN_FILE="${SECRETS_DIR}/qa-api-token"
ZADIG_URL="http://${ZADIG_NODE_IP}:${ZADIG_NODE_PORT}"

log() { printf '[zadig-bootstrap] %s\n' "$*"; }
die() { printf '[zadig-bootstrap] ERROR: %s\n' "$*" >&2; exit 1; }

[[ "$(id -u)" == "0" ]] || die "run as root: sudo bash ${SCRIPT_DIR}/bootstrap.sh"
[[ "${ZADIG_ROOT}" == /data00/multiremi/zadig ]] || die "unexpected ZADIG_ROOT: ${ZADIG_ROOT}"

install -d -m 0700 "${SECRETS_DIR}"

wait_for_zadig() {
  local code=""
  for _ in $(seq 1 120); do
    code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' --max-time 5 "${ZADIG_URL}/api/aslan/system/initialization/status" || true)"
    [[ "${code}" == "200" ]] && return
    sleep 2
  done
  die "Zadig initialization API did not become ready within 240 seconds"
}

ensure_admin_password() {
  if [[ -e "${ADMIN_PASSWORD_FILE}" ]]; then
    [[ -f "${ADMIN_PASSWORD_FILE}" && ! -L "${ADMIN_PASSWORD_FILE}" ]] || die "invalid admin password path"
  else
    umask 077
    printf 'Zadig-%s' "$(openssl rand -hex 16)" > "${ADMIN_PASSWORD_FILE}"
  fi
  chmod 0600 "${ADMIN_PASSWORD_FILE}"
}

ensure_qa_password() {
  if [[ -e "${QA_PASSWORD_FILE}" ]]; then
    [[ -f "${QA_PASSWORD_FILE}" && ! -L "${QA_PASSWORD_FILE}" ]] || die "invalid QA credential path"
  else
    umask 077
    printf 'Zadig-%s' "$(openssl rand -hex 16)" > "${QA_PASSWORD_FILE}"
  fi
  chmod 0600 "${QA_PASSWORD_FILE}"
}

initialize_admin() {
  local initialized response_file http_code
  initialized="$(curl --noproxy '*' -fsS "${ZADIG_URL}/api/aslan/system/initialization/status" | jq -r '.initialized')"
  if [[ "${initialized}" == "true" ]]; then
    log "administrator already initialized"
    return
  fi

  response_file="$(mktemp "${ZADIG_ROOT}/admin-init.XXXXXX")"
  trap 'find "${response_file}" -xdev -delete 2>/dev/null || true' RETURN
  http_code="$(
    jq -n \
      --arg username "${ZADIG_ADMIN_USERNAME}" \
      --arg password "$(<"${ADMIN_PASSWORD_FILE}")" \
      --arg company "${ZADIG_ADMIN_COMPANY}" \
      --arg email "${ZADIG_ADMIN_EMAIL}" \
      '{username:$username,password:$password,company:$company,email:$email,phone:0,improvement_plan:false}' |
      curl --noproxy '*' -sS -o "${response_file}" -w '%{http_code}' \
        -H 'Content-Type: application/json' --data-binary @- \
        "${ZADIG_URL}/api/aslan/system/initialization/user"
  )"
  [[ "${http_code}" == "200" ]] || die "administrator initialization failed with HTTP ${http_code}"
  find "${response_file}" -xdev -delete
  trap - RETURN
  log "initialized administrator ${ZADIG_ADMIN_USERNAME}"
}

encrypt_login_payload() {
  local account="$1" password="$2" public_key_file aes_key aes_key_hex iv_hex encrypted_key encrypted_password
  public_key_file="$(mktemp "${ZADIG_ROOT}/rsa-public.XXXXXX")"
  trap 'find "${public_key_file}" -xdev -delete 2>/dev/null || true' RETURN

  curl --noproxy '*' -fsS "${ZADIG_URL}/api/aslan/system/rsaKey/publicKey" |
    jq -r '.publicKey' |
    sed 's/BEGIN RSA PUBLIC KEY/BEGIN PUBLIC KEY/; s/END RSA PUBLIC KEY/END PUBLIC KEY/' > "${public_key_file}"
  aes_key="$(openssl rand -hex 16)"
  aes_key_hex="$(printf '%s' "${aes_key}" | od -An -tx1 | tr -d ' \n')"
  iv_hex="$(openssl rand -hex 16)"
  encrypted_key="$(
    printf '%s' "${aes_key}" |
      openssl pkeyutl -encrypt -pubin -inkey "${public_key_file}" -pkeyopt rsa_padding_mode:pkcs1 |
      openssl base64 -A
  )"
  encrypted_password="${iv_hex}$(
    printf '%s' "${password}" |
      openssl enc -aes-256-cfb -K "${aes_key_hex}" -iv "${iv_hex}" -nosalt |
      od -An -tx1 | tr -d ' \n'
  )"
  find "${public_key_file}" -xdev -delete
  trap - RETURN

  jq -n \
    --arg account "${account}" \
    --arg encrypted_key "${encrypted_key}" \
    --arg password "${encrypted_password}" \
    '{account:$account,encrypted_key:$encrypted_key,password:$password}'
}

configure_concurrency() {
  local login_file token_file login_code uid session_token api_token concurrency_code
  login_file="$(mktemp "${ZADIG_ROOT}/admin-login.XXXXXX")"
  token_file="$(mktemp "${ZADIG_ROOT}/admin-token.XXXXXX")"
  trap 'find "${login_file}" "${token_file}" -xdev -delete 2>/dev/null || true' RETURN

  login_code="$(
    encrypt_login_payload "${ZADIG_ADMIN_USERNAME}" "$(<"${ADMIN_PASSWORD_FILE}")" |
      curl --noproxy '*' -sS -o "${login_file}" -w '%{http_code}' \
        -H 'Content-Type: application/json' --data-binary @- \
        "${ZADIG_URL}/api/v1/login"
  )"
  [[ "${login_code}" == "200" ]] || die "administrator login failed with HTTP ${login_code}"
  uid="$(jq -r '.uid // empty' "${login_file}")"
  session_token="$(jq -r '.token // empty' "${login_file}")"
  [[ -n "${uid}" && -n "${session_token}" ]] || die "administrator login response did not contain credentials"

  if [[ ! -s "${ADMIN_API_TOKEN_FILE}" ]]; then
    curl --noproxy '*' -fsS -o "${token_file}" -X POST \
      -H "Authorization: Bearer ${session_token}" \
      "${ZADIG_URL}/api/v1/users/${uid}/token"
    api_token="$(jq -r '.token // empty' "${token_file}")"
    [[ -n "${api_token}" ]] || die "failed to generate administrator API token"
    umask 077
    printf '%s' "${api_token}" > "${ADMIN_API_TOKEN_FILE}"
    chmod 0600 "${ADMIN_API_TOKEN_FILE}"
  fi

  api_token="$(<"${ADMIN_API_TOKEN_FILE}")"
  concurrency_code="$(
    jq -n \
      --argjson workflow "${PPE_BUILD_CONCURRENCY}" \
      --argjson build "${PPE_BUILD_CONCURRENCY}" \
      '{workflow_concurrency:$workflow,build_concurrency:$build}' |
      curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer ${api_token}" \
        --data-binary @- "${ZADIG_URL}/api/aslan/system/concurrency/workflow"
  )"
  [[ "${concurrency_code}" == "200" ]] || die "concurrency update failed with HTTP ${concurrency_code}"

  find "${login_file}" "${token_file}" -xdev -delete
  trap - RETURN
  log "workflow and task concurrency set to ${PPE_BUILD_CONCURRENCY}"
}

configure_qa_account() {
  local admin_api_token search_file user_file response_file login_file token_file qa_uid login_uid session_token qa_api_token http_code
  admin_api_token="$(<"${ADMIN_API_TOKEN_FILE}")"
  search_file="$(mktemp "${ZADIG_ROOT}/qa-search.XXXXXX")"
  user_file="$(mktemp "${ZADIG_ROOT}/qa-user.XXXXXX")"
  response_file="$(mktemp "${ZADIG_ROOT}/qa-response.XXXXXX")"
  login_file="$(mktemp "${ZADIG_ROOT}/qa-login.XXXXXX")"
  token_file="$(mktemp "${ZADIG_ROOT}/qa-token.XXXXXX")"
  trap 'find "${search_file}" "${user_file}" "${response_file}" "${login_file}" "${token_file}" -xdev -delete 2>/dev/null || true' RETURN

  jq -n --arg account "${ZADIG_QA_USERNAME}" '{account:$account,page:1,per_page:20}' |
    curl --noproxy '*' -fsS -o "${search_file}" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${admin_api_token}" \
      --data-binary @- "${ZADIG_URL}/api/v1/users/search"
  qa_uid="$(jq -r --arg account "${ZADIG_QA_USERNAME}" '.users[]? | select(.account == $account) | .uid' "${search_file}" | head -n 1)"

  if [[ -z "${qa_uid}" ]]; then
    http_code="$(
      jq -n \
        --arg name "${ZADIG_QA_DISPLAY_NAME}" \
        --arg account "${ZADIG_QA_USERNAME}" \
        --arg password "$(<"${QA_PASSWORD_FILE}")" \
        --arg email "${ZADIG_QA_EMAIL}" \
        '{name:$name,account:$account,password:$password,email:$email}' |
        curl --noproxy '*' -sS -o "${user_file}" -w '%{http_code}' \
          -H 'Content-Type: application/json' \
          -H "Authorization: Bearer ${admin_api_token}" \
          --data-binary @- "${ZADIG_URL}/api/v1/users"
    )"
    [[ "${http_code}" == "200" || "${http_code}" == "201" ]] || die "QA account creation failed with HTTP ${http_code}"
    qa_uid="$(jq -r '.uid // empty' "${user_file}")"
    [[ -n "${qa_uid}" ]] || die "QA account response did not contain a uid"
    log "created isolated QA account ${ZADIG_QA_USERNAME}"
  fi

  http_code="$(
    jq -n '{api_token_enabled:true}' |
      curl --noproxy '*' -sS -o "${response_file}" -w '%{http_code}' -X PUT \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer ${admin_api_token}" \
        --data-binary @- "${ZADIG_URL}/api/v1/users/${qa_uid}"
  )"
  [[ "${http_code}" == "200" ]] || die "QA API access enablement failed with HTTP ${http_code}"

  if [[ ! -s "${QA_API_TOKEN_FILE}" || "${ROTATE_ZADIG_QA_TOKEN:-0}" == "1" ]]; then
    http_code="$(
      encrypt_login_payload "${ZADIG_QA_USERNAME}" "$(<"${QA_PASSWORD_FILE}")" |
        curl --noproxy '*' -sS -o "${login_file}" -w '%{http_code}' \
          -H 'Content-Type: application/json' --data-binary @- \
          "${ZADIG_URL}/api/v1/login"
    )"
    [[ "${http_code}" == "200" ]] || die "QA login failed with HTTP ${http_code}"
    login_uid="$(jq -r '.uid // empty' "${login_file}")"
    session_token="$(jq -r '.token // empty' "${login_file}")"
    [[ "${login_uid}" == "${qa_uid}" && -n "${session_token}" ]] || die "QA login response did not contain expected credentials"

    http_code="$(
      curl --noproxy '*' -sS -o "${token_file}" -w '%{http_code}' -X POST \
        -H "Authorization: Bearer ${session_token}" \
        "${ZADIG_URL}/api/v1/users/${qa_uid}/token"
    )"
    [[ "${http_code}" == "200" ]] || die "QA API credential generation failed with HTTP ${http_code}"
    qa_api_token="$(jq -r '.token // empty' "${token_file}")"
    [[ -n "${qa_api_token}" ]] || die "QA API credential response was empty"
    umask 077
    printf '%s' "${qa_api_token}" > "${QA_API_TOKEN_FILE}"
  fi
  chmod 0600 "${QA_API_TOKEN_FILE}"

  qa_api_token="$(<"${QA_API_TOKEN_FILE}")"
  http_code="$(curl --noproxy '*' -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${qa_api_token}" "${ZADIG_URL}/api/v1/users/${qa_uid}/personal")"
  [[ "${http_code}" == "200" ]] || die "QA API credential validation failed with HTTP ${http_code}"

  find "${search_file}" "${user_file}" "${response_file}" "${login_file}" "${token_file}" -xdev -delete
  trap - RETURN
  log "QA account is ready without system administrator authority"
}

wait_for_zadig
ensure_admin_password
ensure_qa_password
initialize_admin
configure_concurrency
configure_qa_account

log "administrator credential files are stored under ${SECRETS_DIR} with mode 0600"
