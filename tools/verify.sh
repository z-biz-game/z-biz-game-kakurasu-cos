#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real server,
# driven over CDP. Everything exits with the script, including the Chrome it started in a temp
# profile.
#
# PORTS: web :5192, devtools :9352. They are this repo's pair and must not be reused by a
# sibling game in the same farm run — :5180/:5181 (gridlock, nine-rings) and :9340/:9341 are
# already taken by them, and a colliding CDP port makes the driver attach to someone else's
# tab and report "0 browser asserts" as if it were a pass.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterization saturates the cores and, with no CDP client attached, the process will not exit
# on its own. This game is 2D canvas, so plain headless Chrome is enough.
#
#   bash tools/verify.sh                              # node suites + @boot @play @routes @save @reloaded @pointer
#   SCENARIOS="pointer" bash tools/verify.sh          # one browser suite while editing the view
#   SKIP_UNIT=1 bash tools/verify.sh                  # browser only (what the CI browser job does)
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9352}
WEB_PORT=${WEB_PORT:-5192}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
NAME=kakurasu
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# Another builder's Chrome on this port would silently be driven instead of ours.
if lsof -nP -iTCP:$CDP_PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "devtools port :$CDP_PORT is already listening; another Chrome is up. Wait or set CDP_PORT." >&2
  pgrep -fl remote-debugging-port >&2
  exit 6
fi

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >/tmp/$NAME-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/$NAME-server.log 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# Watchdog redirects its fds: a background subshell inherits the script's stdout, and if this
# runs inside a pipeline it would hold the write end open for the full timeout and stall the
# consumer long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools noticeably later than a warm profile, so wait on the
# endpoints rather than guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    node "$f" || FAILED=1
  done
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# The shell resolves a route before it reports a state, and js/data/lots.js is 40 measured rows,
# so wait on window.kakurasu rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.kakurasu?window.kakurasu.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot lot: $BOOT"
[ "$BOOT" = "nope" ] && { echo "window.kakurasu never appeared at $BASE" >&2; exit 5; }

# @reloaded has to run after @save (it reads what @save left on disk) and each scenario runs in
# its own driver process, which is what makes the "eval without nonav" reload real.
for s in ${SCENARIOS:-boot play routes save reloaded pointer}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
start = raw.find("{")
if start < 0:
    print("NO RESULT", raw[-300:]); sys.exit(1)
depth = 0
for i in range(start, len(raw)):
    if raw[i] == "{": depth += 1
    elif raw[i] == "}":
        depth -= 1
        if depth == 0:
            try: d = json.loads(raw[start:i + 1])
            except Exception as e:
                print("BAD JSON", e, raw[start:start+200]); sys.exit(1)
            break
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r["detail"], ensure_ascii=False)[:240])
sys.exit(1 if d.get("fail") else 0)
' || FAILED=1
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:error\]|\[error\]|\[warning\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "/tmp/$NAME-$s.png" >/dev/null 2>&1
done

echo "=== console ==="
node tools/playtest.mjs logs
kill $WD 2>/dev/null
wait $WD 2>/dev/null
# 文档行号对账：README/DESIGN 里每一条 `path:行号` 读回盘上核对。插在 wait 之后是硬约束——
# 本文档引用了 verify.sh 的 20/21/35-39/88/132 行，往这些行上面插任何东西都会把文档的引用挪歪。
echo "=== doctest ==="
node tools/docs-test.mjs || FAILED=1
# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑。缺这一步就是「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一整类坏法。它不碰 Chrome，也不读页面，纯查产物。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || FAILED=1
node tools/deploy-set-selftest.mjs || FAILED=1
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
