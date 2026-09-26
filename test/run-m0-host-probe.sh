#!/bin/sh
set -eu

DSH_PROBE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DSH_PROBE_APP=${DSH_PROBE_APP:-/Applications/DeepSeek Harness.app}
DSH_PROBE_BIN="$DSH_PROBE_APP/Contents/MacOS/DeepSeek Harness"
DSH_PROBE_ASAR="$DSH_PROBE_APP/Contents/Resources/app.asar"
DSH_PROBE_CLI="$DSH_PROBE_APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
DSH_PROBE_RUNTIME="$DSH_PROBE_APP/Contents/Resources/runtime/bin"

if [ ! -x "$DSH_PROBE_BIN" ] || [ ! -f "$DSH_PROBE_ASAR" ] || [ ! -x "$DSH_PROBE_RUNTIME/node" ]; then
  printf '%s\n' 'Set DSH_PROBE_APP to the installed DeepSeek Harness.app bundle.' >&2
  exit 1
fi

DSH_PROBE_HOME=$(mktemp -d "${TMPDIR:-/tmp}/dsh-mobile-m0-host.XXXXXX")
DSH_PROBE_PATCH="$DSH_PROBE_HOME/m0-host-probe.patch.yml"
DSH_PROBE_LOG="$DSH_PROBE_HOME/host.log"
DSH_PROBE_MARKER="$DSH_PROBE_HOME/m0-host-probe.json"
DSH_PROBE_PID=
DSH_PROBE_RESULT=failed

cleanup() {
  if [ -n "$DSH_PROBE_PID" ]; then
    kill "$DSH_PROBE_PID" 2>/dev/null || true
    wait "$DSH_PROBE_PID" 2>/dev/null || true
  fi
  if [ "$DSH_PROBE_RESULT" = passed ]; then
    rm -rf "$DSH_PROBE_HOME"
  else
    printf 'Isolated DSH_HOME retained for failure inspection: %s\n' "$DSH_PROBE_HOME" >&2
  fi
}
trap cleanup EXIT INT TERM

printf '%s\n' \
  '- insert:' \
  '    - id: dsh-remote' \
  "      name: $DSH_PROBE_ROOT/dist/index.js" \
  '      config:' \
  '        bindHost: 127.0.0.1' \
  '        bindPort: 0' \
  '    - id: m0-host-probe' \
  "      name: $DSH_PROBE_ROOT/test/m0-host-probe-plugin.mjs" \
  > "$DSH_PROBE_PATCH"

DSH_HOME="$DSH_PROBE_HOME" ELECTRON_RUN_AS_NODE=1 \
  "$DSH_PROBE_BIN" "$DSH_PROBE_CLI" \
  --profile web --patch "$DSH_PROBE_PATCH" --no-open --port 0 \
  > "$DSH_PROBE_LOG" 2>&1 &
DSH_PROBE_PID=$!

DSH_PROBE_ATTEMPT=0
while [ ! -f "$DSH_PROBE_MARKER" ] && [ "$DSH_PROBE_ATTEMPT" -lt 60 ]; do
  if ! kill -0 "$DSH_PROBE_PID" 2>/dev/null; then
    break
  fi
  sleep 1
  DSH_PROBE_ATTEMPT=$((DSH_PROBE_ATTEMPT + 1))
done

if [ ! -f "$DSH_PROBE_MARKER" ]; then
  printf 'Isolated DSH Host did not become ready; inspect the private log at %s\n' "$DSH_PROBE_LOG" >&2
  exit 1
fi

DSH_HOME="$DSH_PROBE_HOME" \
DSH_DESKTOP_NODE_EXECUTABLE="$DSH_PROBE_BIN" \
ELECTRON_RUN_AS_NODE=1 \
PATH="$DSH_PROBE_RUNTIME:$PATH" \
  node "$DSH_PROBE_ROOT/test/m0-host-roundtrip.mjs"

DSH_PROBE_RESULT=passed
printf '%s\n' 'Isolated DSH Host probe passed; temporary profile will be removed.'
