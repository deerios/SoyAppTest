#!/usr/bin/env bash
# Builds and installs the app on the dev subreddit, then watches for changes.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  npm install
fi

npm run playtest
