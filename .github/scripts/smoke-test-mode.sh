#!/usr/bin/env bash
set -euo pipefail

# Checks a running test-mode server (docs/plans/test-mode.md): personas sign
# in with a real session, admission works as in production, and the seed
# landed. CI runs it in the test-mode job; locally:
#
#   bash .github/scripts/smoke-test-mode.sh http://localhost:3001

BASE_URL="${1:-http://localhost:3001}"
failures=0

# Prints the HTTP status, or 000 when the server did not answer. Always returns
# 0 so it is safe inside $(...) under `set -e`.
status_of() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}$1" || true
  return 0
}

# Prints the sous_session=... pair from a persona's sign-in, or nothing.
session_for() {
  curl -s -o /dev/null -D - --max-time 10 "${BASE_URL}/__test/sign-in?as=$1" \
    | tr -d '\r' \
    | sed -n 's/^[Ss]et-[Cc]ookie: \(sous_session=[^;]*\).*/\1/p' || true
  return 0
}

# Prints the body of a GET with a cookie, or nothing.
body_with() {
  curl -s --max-time 10 -H "Cookie: $1" "${BASE_URL}$2" || true
  return 0
}

check() {
  local name="$1" ok="$2"
  if [[ "$ok" == "yes" ]]; then
    printf 'ok    %s\n' "$name"
  else
    printf 'FAIL  %s\n' "$name"
    failures=$((failures + 1))
  fi
}

contains() {
  if [[ "$1" == *"$2"* ]]; then echo yes; else echo no; fi
  return 0
}

printf 'Waiting for %s\n' "$BASE_URL"
for _ in $(seq 1 60); do
  if [[ "$(status_of /__test/personas)" == "200" ]]; then
    break
  fi
  sleep 1
done
if [[ "$(status_of /__test/personas)" != "200" ]]; then
  printf 'FAIL  test server never answered at %s\n' "$BASE_URL"
  exit 1
fi

sign_in_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${BASE_URL}/__test/sign-in?as=member" || true)"
check 'sign-in answers 303' "$([[ "$sign_in_status" == "303" ]] && echo yes || echo no)"

member="$(session_for member)"
check 'member gets a sous_session cookie' "$([[ -n "$member" ]] && echo yes || echo no)"
check 'member session is test-member' \
  "$(contains "$(body_with "$member" /api/auth/session)" '"sub":"test-member"')"

pull="$(body_with "$member" /api/sync/pull)"
for n in 101 102 103 104 105 106; do
  check "member pull has fixture recipe ${n}" "$(contains "$pull" "00000000-0000-4000-8000-000000000${n}")"
done

viewer="$(session_for viewer)"
check 'viewer sees a shared collection' \
  "$(contains "$(body_with "$viewer" /api/sync/shared)" '"role":"viewer"')"

owner="$(session_for owner)"
check 'owner sees the pending request on /admin' \
  "$(contains "$(body_with "$owner" /api/admin/requests)" '"sub":"test-outsider"')"

outsider="$(session_for outsider)"
check 'outsider is not admitted' \
  "$(contains "$(body_with "$outsider" /api/auth/session)" '"user":null')"

check 'unknown persona is 404' "$([[ "$(status_of '/__test/sign-in?as=nobody')" == "404" ]] && echo yes || echo no)"
check 'pull without a cookie is 401' "$([[ "$(status_of /api/sync/pull)" == "401" ]] && echo yes || echo no)"

if (( failures > 0 )); then
  printf '%d test-mode check(s) failed\n' "$failures"
  exit 1
fi
printf 'All test-mode checks passed\n'
