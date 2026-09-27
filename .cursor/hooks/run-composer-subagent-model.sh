#!/bin/bash
# Cloud agents load this repo hook, not ~/.cursor/hooks.json.
# Node on those VMs is installed through nvm and is not always on PATH yet.
set -euo pipefail
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  set +u
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1 || true
  set -u
fi
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$dir/composer-subagent-model.js"
