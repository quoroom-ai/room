#!/usr/bin/env bash
set -euo pipefail

fail=0

notice() { echo "::notice::$*"; }
warn() { echo "::warning::$*"; }
error() {
  echo "::error::$*"
  fail=1
}

decode_base64_to_file() {
  local payload="$1"
  local out="$2"
  if printf '%s' "$payload" | base64 --decode >"$out" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$payload" | base64 -d >"$out" 2>/dev/null; then
    return 0
  fi
  if printf '%s' "$payload" | base64 -D >"$out" 2>/dev/null; then
    return 0
  fi
  return 1
}

require_nonempty() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then
    error "Secret '$name' is missing or empty."
    return
  fi
  if [ "$value" = "$name" ]; then
    error "Secret '$name' appears to contain its own key name (placeholder value)."
    return
  fi
  notice "Secret '$name' is set."
}

validate_base64_secret() {
  local name="$1"
  local min_bytes="$2"
  local value="${!name:-}"
  local tmp
  tmp="$(mktemp)"

  if ! decode_base64_to_file "$value" "$tmp"; then
    rm -f "$tmp"
    error "Secret '$name' is not valid base64."
    return
  fi

  local bytes
  bytes="$(wc -c <"$tmp" | tr -d ' ')"
  rm -f "$tmp"
  if [ "${bytes}" -lt "${min_bytes}" ]; then
    error "Secret '$name' decoded payload is unexpectedly small (${bytes} bytes)."
    return
  fi

  notice "Secret '$name' decoded successfully (${bytes} bytes)."
}

validate_optional_cert_pair() {
  local cert_name="$1"
  local pass_name="$2"
  local cert_value="${!cert_name:-}"
  local pass_value="${!pass_name:-}"

  if [ -z "$cert_value" ] && [ -z "$pass_value" ]; then
    warn "Optional signing pair '$cert_name'/'$pass_name' is not set. Binary codesign will be skipped."
    return
  fi

  if [ -z "$cert_value" ] || [ -z "$pass_value" ]; then
    error "Optional signing pair '$cert_name'/'$pass_name' must both be set or both be empty."
    return
  fi

  validate_base64_secret "$cert_name" 1024
  notice "Optional signing pair '$cert_name'/'$pass_name' is configured."
}

require_nonempty "APPLE_ID"
require_nonempty "APPLE_APP_PASSWORD"
require_nonempty "APPLE_TEAM_ID"
require_nonempty "CSC_INSTALLER_LINK"
require_nonempty "CSC_INSTALLER_PASSWORD"
require_nonempty "ES_USERNAME"
require_nonempty "ES_PASSWORD"
require_nonempty "ES_CREDENTIAL_ID"
require_nonempty "ES_TOTP_SECRET"
require_nonempty "NPM_TOKEN"
require_nonempty "HOMEBREW_TAP_TOKEN"

if [ -n "${APPLE_ID:-}" ] && ! printf '%s' "${APPLE_ID}" | grep -Eq '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'; then
  error "APPLE_ID does not look like an email address."
fi

if [ -n "${APPLE_TEAM_ID:-}" ] && ! printf '%s' "${APPLE_TEAM_ID}" | grep -Eq '^[A-Z0-9]{10}$'; then
  error "APPLE_TEAM_ID should look like a 10-character Apple Team ID."
fi

if [ -n "${APPLE_APP_PASSWORD:-}" ] && ! printf '%s' "${APPLE_APP_PASSWORD}" | grep -Eq '^[a-z]{4}(-[a-z]{4}){3}$'; then
  warn "APPLE_APP_PASSWORD does not match app-specific password pattern xxxx-xxxx-xxxx-xxxx."
fi

if [ -n "${CSC_INSTALLER_LINK:-}" ]; then
  validate_base64_secret "CSC_INSTALLER_LINK" 1024
fi

validate_optional_cert_pair "CSC_LINK" "CSC_KEY_PASSWORD"

if command -v xcrun >/dev/null 2>&1; then
  if xcrun notarytool history \
    --apple-id "${APPLE_ID}" \
    --password "${APPLE_APP_PASSWORD}" \
    --team-id "${APPLE_TEAM_ID}" \
    --output-format json >/dev/null 2>&1; then
    notice "Apple notary authentication succeeded."
  else
    error "Apple notary authentication failed for APPLE_ID/APPLE_APP_PASSWORD/APPLE_TEAM_ID."
  fi
else
  warn "xcrun not available; skipped live Apple notarization auth test."
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

notice "All release secret checks passed."
