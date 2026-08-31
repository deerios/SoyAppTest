#!/bin/bash
# Runs soybot locally against the real config.yaml but a local, disposable
# state/posted-videos file, so testing doesn't touch the committed state.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo ".env not found. Copy .env.example to .env and fill in your secrets." >&2
    exit 1
fi

set -a
source .env
set +a

export SOYBOT_CONFIG_PATH="${SOYBOT_CONFIG_PATH:-config.yaml}"
export SOYBOT_STATE_PATH="${SOYBOT_STATE_PATH:-local_state.json}"
export SOYBOT_POSTED_VIDEOS_PATH="${SOYBOT_POSTED_VIDEOS_PATH:-local_posted_videos.json}"
export SOYBOT_QUEUE_PATH="${SOYBOT_QUEUE_PATH:-local_queue.json}"

python3 app.py
