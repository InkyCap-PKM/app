#!/bin/bash
# Usage: scripts/webkit-harness/run.sh '<js expression>' — prints the scenario's doc and log.
cd "$(dirname "$0")/../.." && WEBKIT_DISABLE_COMPOSITING_MODE=1 timeout 40 python3 scripts/webkit-harness/drive.py "$1" 2>&1 | grep -v "^$" | python3 -c "
import sys, json
raw = sys.stdin.read()
i = raw.find('{')
if i < 0: print(raw); sys.exit()
try: r = json.loads(raw[i:])
except Exception: print(raw); sys.exit()
print('DOC:', repr(r.get('doc')))
for l in r.get('log', []): print(l)
"
