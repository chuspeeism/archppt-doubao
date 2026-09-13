#!/bin/zsh
# start.command —— 豆包特供版一键启动器。Finder 里双击就能跑。
#
# 把三件事串成一条链：
#   1) 起面板服务（后台）并打开 http://localhost:7431
#   2) 写 phase:waiting，等剪贴板里出现架构图 JSON（watch-clipboard.mjs --once）
#   3) 写 phase:received，跑 draw.mjs 驱动 PowerPoint 一个一个画
#   4) 终端提示「按回车关闭」，关掉面板服务
#
# 路径全部按脚本自身位置解析（${0:A:h}），拖到哪儿双击都对。

set -u
setopt no_nomatch 2>/dev/null

HERE="${0:A:h}"
STATE="$HERE/.state"
EVENTS="$STATE/steps.jsonl"
INBOX="$STATE/inbox"
PORT="${DOUBAO_PANEL_PORT:-7431}"
DELAY="${DOUBAO_DRAW_DELAY:-400}"
WAIT_SECONDS="${DOUBAO_WAIT_SECONDS:-600}"

mkdir -p "$STATE" "$INBOX"

# --- Node 自检 -------------------------------------------------------------
# 双击起来的进程拿不到交互 shell 的 PATH（nvm / homebrew 都在那儿配的），
# 所以先把常见位置补进 PATH，再报错。
export PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node。装一个 Node 18+（brew install node），或把 node 所在目录加进 PATH。"
  echo "按回车关闭…"; read -r _; exit 1
fi

# 事件文件与 JSON 追加：一行一个对象，见 panel/CONTRACT.md
emit() { printf '%s\n' "$1" >> "$EVENTS"; }
now_iso() { node -e 'process.stdout.write(new Date().toISOString())'; }

cleanup() {
  if [[ -n "${PANEL_PID:-}" ]] && kill -0 "$PANEL_PID" 2>/dev/null; then
    kill "$PANEL_PID" 2>/dev/null
    wait "$PANEL_PID" 2>/dev/null
  fi
}
trap cleanup EXIT INT TERM

# --- 1) 面板服务 -----------------------------------------------------------
# 每次都从空的事件文件开始，免得面板把上一轮的步骤当成这一轮的
: > "$EVENTS"

if lsof -ti "tcp:$PORT" >/dev/null 2>&1; then
  echo "端口 $PORT 已被占用（多半是上一次的面板还在跑）。"
  echo "关掉它：lsof -ti tcp:$PORT | xargs kill"
  echo "按回车关闭…"; read -r _; exit 1
fi

node "$HERE/panel/server.mjs" --port "$PORT" --events "$EVENTS" &
PANEL_PID=$!
sleep 1
if ! kill -0 "$PANEL_PID" 2>/dev/null; then
  echo "面板服务没起来，看看上面的报错。"
  echo "按回车关闭…"; read -r _; exit 1
fi
echo "面板已就绪：http://localhost:$PORT"
open "http://localhost:$PORT"

# --- 2) 等剪贴板 -----------------------------------------------------------
emit "{\"ts\":\"$(now_iso)\",\"type\":\"phase\",\"phase\":\"waiting\"}"
echo ""
echo "请在豆包里把架构图 JSON 复制一下（最多等 ${WAIT_SECONDS} 秒）…"

WATCH_OUT="$STATE/watch.jsonl"
node "$HERE/watch-clipboard.mjs" --once --timeout="$WAIT_SECONDS" --json-out --inbox="$INBOX" \
  | tee "$WATCH_OUT"
WATCH_RC=${pipestatus[1]}

if [[ "$WATCH_RC" -ne 0 ]]; then
  case "$WATCH_RC" in
    3) MSG="等了 ${WAIT_SECONDS} 秒没检测到复制动作，这次就到这儿。再跑一次即可。" ;;
    *) MSG="剪贴板监听退出（码 $WATCH_RC），看上面的输出。" ;;
  esac
  echo "$MSG"
  emit "{\"ts\":\"$(now_iso)\",\"type\":\"error\",\"message\":\"$MSG\"}"
  echo "按回车关闭…"; read -r _; exit "$WATCH_RC"
fi

# accepted 事件那一行带着绝对路径和标题
ACCEPTED_LINE=$(grep '"type":"accepted"' "$WATCH_OUT" | tail -1)
SPEC=$(printf '%s' "$ACCEPTED_LINE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).path||"")}catch(e){}})')

if [[ -z "$SPEC" || ! -f "$SPEC" ]]; then
  MSG="监听器说收到了，但没拿到 spec 路径。看 $WATCH_OUT。"
  echo "$MSG"
  emit "{\"ts\":\"$(now_iso)\",\"type\":\"error\",\"message\":\"$MSG\"}"
  echo "按回车关闭…"; read -r _; exit 1
fi

# --- 3) 画 -----------------------------------------------------------------
# phase:received 直接把监听器那一行的字段搬过来，加上 specPath
printf '%s' "$ACCEPTED_LINE" | node -e '
let s = "";
process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  try {
    const a = JSON.parse(s);
    process.stdout.write(JSON.stringify({
      ts: new Date().toISOString(), type: "phase", phase: "received",
      title: a.title ?? null, nodes: a.nodes ?? null, edges: a.edges ?? null, specPath: a.path,
    }) + "\n");
  } catch (e) { /* 拿不到就不写这条，面板会从 layout 起 */ }
});' >> "$EVENTS"

echo ""
echo "收到 spec：$SPEC"
echo "开始画（每步停 ${DELAY}ms）——PowerPoint 会被拉到前台，别动鼠标。"
echo ""

node "$HERE/draw.mjs" "$SPEC" --delay "$DELAY" --events "$EVENTS" --append
DRAW_RC=$?

echo ""
if [[ "$DRAW_RC" -eq 0 ]]; then
  echo "画完了。pptx 的路径在面板上和上面的 phase:done 那一行里。"
else
  echo "没画成（退出码 $DRAW_RC），看上面的输出和面板上的错误。"
fi

echo ""
echo "按回车关闭…"
read -r _
exit "$DRAW_RC"
