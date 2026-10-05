# 游戏启动脚本（Windows PowerShell 对等实现，需求 场景 20）
#   .\start.ps1                构建 + 后台启动 + 健康检查 + 报判题栈可用性
#   .\start.ps1 -Rebuild       强制无缓存重建
#   .\start.ps1 -Dev           开发模式（vite 5173 + 后端 watch）
#   .\start.ps1 -Ide           起服务并直接打开网页 IDE（同一个容器，只是换个落地页）
#   .\start.ps1 -Logs          跟踪容器日志
#   .\start.ps1 -BridgeLogs    跟踪宿主 CLI 桥日志（主观题掉成人工自检表时先看这里）
#   .\start.ps1 -Down          停止（顺带收掉 E2E 隔离实例）
#   .\start.ps1 -Verify        容器内跑 npm run verify（含判题矩阵；E2E 去宿主跑）
#   .\start.ps1 -E2E           给出宿主跑 E2E 的命令（默认浏览器 Edge）
#   .\start.ps1 -E2E -InContainer   确实要在容器里跑（bundled Chromium，不是 Edge）
#   .\start.ps1 -Status        compose 视角的运行状态
# 文件必须保持 UTF-8 **带 BOM**：Windows PowerShell 5.1 读无 BOM 的中文脚本会解析失败。
param(
  [switch]$Rebuild,
  [switch]$Dev,
  [switch]$Ide,
  [switch]$Logs,
  [switch]$BridgeLogs,
  [switch]$Down,
  [switch]$Verify,
  [switch]$E2E,
  [switch]$InContainer,
  [switch]$Status
)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$Health = 'http://localhost:7788/api/health'
$EnvFile = Join-Path $PSScriptRoot '.env'
$BridgePidFile = 'data\llm-bridge.pid'
$BridgeTokenFile = 'data\llm-bridge.token'

# PowerShell 5.1 里原生命令非零退出**不会**触发 $ErrorActionPreference='Stop'，
# 所以每条 docker 调用都要自己看 $LASTEXITCODE —— 否则构建失败照样 up -d，起的是上一个镜像。
function Invoke-Step {
  param([string]$Label, [scriptblock]$Body)
  & $Body
  if ($LASTEXITCODE -ne 0) {
    Write-Host "[arena] $Label 失败（exit $LASTEXITCODE）：没有继续起服务" -ForegroundColor Red
    exit $LASTEXITCODE
  }
}

# 读写逻辑只这一份：桥与 notebook 各一对 wrapper（与 start.sh 的 read_env_key / write_env_key 同判据）。
# 分叉成两份的下场一定是"其中一份说假话"。
function Read-EnvKey([string]$key) {
  # 缺参数就炸，不要静默拿空串去匹配（与 start.sh 的 ${1:?} 同判据：PS 这边没有 set -u 兜着，
  # 少传一个参数只会得到 $key = ''，于是 "^=" 谁也匹配不到 ⇒ 读回来是空 ⇒ 上层以为"没有 token"）
  if (-not $key) { throw 'Read-EnvKey 需要键名' }
  if (Test-Path $EnvFile) {
    # 这里**不加** -Encoding UTF8，与下面 Write-EnvKey 里的 Get-Content 不同，是实测出来的差别而不是疏忽：
    # PS 5.1 的 Select-String 默认就按 UTF-8 解码（实测同一行中文值：默认与 -Encoding UTF8 拿到的码点
    # 完全相同、长度相同），而 Get-Content 默认按 ANSI(本机 GB2312) 解码（会把中文行尾的字节当双字节
    # 字符前导字节、连换行一起吃掉 ⇒ 两行并一行）。两边都写 -Encoding UTF8 只会让人以为"这边原本也有
    # 同样的洞"，而它没有。
    $line = Select-String -Path $EnvFile -Pattern "^$key=" | Select-Object -Last 1
    if ($line) { return ($line.Line -split '=', 2)[1] }
  }
  return ''
}

function Write-EnvKey([string]$key, [string]$value) {
  # 同上：缺键名会往 .env 里写一行 "=值"，而 compose 读到的是一行非法键
  if (-not $key) { throw 'Write-EnvKey 需要键名' }
  # 键名先过形状闸门（与 start.sh 的 case 同判据）。旧写法把键名当**正则**用（-notmatch "^$key="），
  # 两类真实故障都从这来（都在临时 .env 上实测过）：`ARENA_[oops` 这种未闭合字符类让比较在第一条
  # 行就抛"未终止的 [] 集"⇒ 整个脚本终止（响亮，但为了一个与 .env 无关的理由）；`ARENA.TOK` 里的
  # `.` 是通配，会**静默删掉别人的行**（`ARENA_TOK=` 被当成同名旧行滤掉，新键照写，rc 一切正常）。
  if ($key -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    # 话要说准：首启时还没有原文件，"原文件一个字节都没动"在那一刻根本没有对象（与 start.sh 同判据）
    $untouched = if (Test-Path $EnvFile) { '原文件一个字节都没动' } else { "这里还没有 $EnvFile，本次也没有创建它" }
    throw "Write-EnvKey 拒绝写入：键名 '$key' 不是合法环境变量名（只允许字母/数字/下划线，且不能以数字开头）—— $untouched，新值也没写"
  }
  if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Path $EnvFile | Out-Null }
  # 滤旧行换成**字面量**前缀比较（StartsWith），键名不再进正则 —— 与 sh 侧换成 awk 字面量比较同判据。
  $prefix = "$key="
  # 读必须显式 -Encoding UTF8：PS 5.1 不带 -Encoding 时按 ANSI 读，而**这台机器的 ANSI 是 GB2312/CP936**
  # （实测 `[Text.Encoding]::Default.WebName` = gb2312）。于是无 BOM 的 UTF-8 .env 会被错映射成别的码点，
  # 更糟的是双字节字符的"前导字节"会把紧跟的 0x0A 一起吃掉 ⇒ 相邻两行合并、那行的键从 .env 里消失
  # （实测 3 行的基准文件读出来是 2 行；再按 UTF-8 写回去就是永久的数据损坏）。
  # 反向的取舍写在这里，别以为没有：真·ANSI(GBK) 存的 .env 用 UTF8 读会得到 U+FFFD —— 但这两个脚本
  # 写出去的一直是 UTF-8 无 BOM，compose 与 server/src/config.ts 读的也是 UTF-8，权威在这一侧。
  $kept = @(Get-Content $EnvFile -Encoding UTF8 | Where-Object { -not $_.StartsWith($prefix) })
  # 写 tmp 再 move（与 sh 侧的 tmp+mv 同一个形状）：旧写法直接 WriteAllText($EnvFile) 会**先截断原文件**，
  # 中途失败（文件被占用 / 磁盘满）就把 .env 留在半截状态、旧内容找不回来 —— sh 侧早就堵掉了这条。
  # 显式 UTF-8 无 BOM + LF：compose 读 .env 时 BOM 会让第一行的键名多个隐形字符，CRLF 会把 \r 带进 token
  $tmp = "$EnvFile.tmp.$PID"
  try {
    [System.IO.File]::WriteAllText($tmp, (($kept + "$key=$value") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
    # 权限要跟过去：Move-Item 保留的是 **tmp 的 ACL**（继承自所在目录，一般含 SYSTEM/Administrators 的
    # FullControl），于是这次改写会把手工收紧过的 .env（例如"只允许当前用户、不继承"）静默降回继承默认
    # —— 而 .env 里是桥 token 与 notebook 的 Jupyter token，那个 Jupyter 还是 entrypoint 里 --allow-root 起的。
    # 有原文件就照抄它的 ACL。新建时不动：Windows 没有 umask 0600 的对等物，硬造一份 ACL 只会把人家的
    # 文件改成谁也读不了的样子 —— 这条与 sh 侧的差别写在这，不是漏了一半。
    if (Test-Path $EnvFile) {
      try { Set-Acl -Path $tmp -AclObject (Get-Acl -Path $EnvFile) }
      catch { Write-Host "[arena] 没能把 $tmp 的权限对齐 $EnvFile（将以默认权限改写 .env）：$($_.Exception.Message)" -ForegroundColor Yellow }
    }
    Move-Item -Force -Path $tmp -Destination $EnvFile -ErrorAction Stop
  } catch {
    # 失败必须让调用方**停下**：throw 会穿过 Start-Bridge 直接终止脚本（等同 sh 侧的 `|| return 1`）。
    # 继续跑等于"进程环境里是新 token、.env 里是旧 token"，而下一次启动读的是 .env ⇒
    # 桥与容器各拿一份 —— 本仓库在桥 token 上撞过一次（WI-86）：容器一路 401、主观题静默降级 manual。
    # 话要说准：tmp 没写出来（磁盘满 / 权限）时不能指着它让人"手工合并"。
    $where = if (Test-Path $tmp) { "新内容在 $tmp，手工合并后删掉它" } else { '临时文件没写出来（磁盘满 / 权限？）' }
    Write-Host "[arena] 没能改写 $EnvFile（$where）：$($_.Exception.Message)" -ForegroundColor Red
    throw
  }
  # 后置条件：写完**读回来对一遍**（与 sh 侧同判据）。Move-Item 返回成功只证明"这次替换发生了"，
  # 不证明 .env 里真是那个值 —— 磁盘满写半截、被别的进程同时改写、值里带换行只落下一行，
  # 都是"短了但一切正常"。本项目在桥 token 上撞过的正是"两份不一致而两边都绿"（WI-86）。
  $got = Read-EnvKey $key
  if ($got -ne $value) {
    $why = "[arena] $EnvFile 里读回的 '$key' 与刚写进去的不一致（读回 '$got' / 期望 '$value'）—— 别再往下跑：检查 $EnvFile 有没有被别的进程改写、值里是不是带了换行"
    Write-Host $why -ForegroundColor Red
    throw $why
  }
}

function Read-EnvToken { return Read-EnvKey 'ARENA_LLM_BRIDGE_TOKEN' }
function Write-EnvToken([string]$token) { Write-EnvKey 'ARENA_LLM_BRIDGE_TOKEN' $token }

# notebook 的 token 与桥同一纪律：唯一来源是 .env（已 gitignore），只在本机之间传递，不进日志。
function Read-EnvJupyterToken { return Read-EnvKey 'ARENA_JUPYTER_TOKEN' }
function Write-EnvJupyterToken([string]$token) { Write-EnvKey 'ARENA_JUPYTER_TOKEN' $token }

function Write-TextFile([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText((Join-Path $PSScriptRoot $path), $text + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

# 端口上真正应答的那个进程才是事实：pid 文件与 token 文件都可能与在跑的那个进程不一致，
# 而"认 token"也不等于"能评分"——桥的进程 PATH 残缺时 runnable 是空的，/health 照样 200，
# 容器侧表现就是 llm-rubric:false + 主观题静默降级成人工自检表（实测踩过，memo 里程碑 Y）。
function Get-BridgeState([string]$token) {
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:7799/health' -Headers @{ 'x-arena-token' = $token } -TimeoutSec 2 -UseBasicParsing
    # 形状也要认：只有我们的桥会回 {"ok":true,"runnable":[…]}。光看 200 会把别人的服务当成健康桥
    if ($resp.Content -notmatch '"ok":\s*true.*"runnable":\s*\[') { return 'foreign' }
    # "认 token"不等于"能评分"：进程 PATH 残缺时 runnable 是空数组，容器侧就是评分链静默降级 manual
    if ($resp.Content -match '"runnable":\s*\[\s*\]') { return 'blind' }
    return 'ours'
  } catch {
    $r = $_.Exception.Response
    if (-not $r) { return 'none' }
    if ([int]$r.StatusCode -eq 401) {
      $text = ''
      try { $text = (New-Object IO.StreamReader($r.GetResponseStream())).ReadToEnd() } catch { }
      # 只有我们自己的桥会用 401 + "token 不匹配"；别人的 401 不能当孤儿桥去杀
      if ($text -match 'token') { return 'stale' }
      return 'foreign'
    }
    return 'foreign'
  }
}

function Stop-BridgeOnPort {
  $conn = Get-NetTCPConnection -LocalPort 7799 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $conn) { return $false }
  Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
  return $?
}

# 容器是 linux，宿主的 qodercli.exe / copilot.exe 进不去 → 由宿主 CLI 桥代跑主观题评分。
# token 只有一个来源（.env），否则桥和容器各拿一份会出现 401 → 评分静默降级 manual。
function Start-Bridge {
  $token = if ($env:ARENA_LLM_BRIDGE_TOKEN) { $env:ARENA_LLM_BRIDGE_TOKEN } else { Read-EnvToken }
  if (-not $token) { $token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N') }
  $env:ARENA_LLM_BRIDGE_TOKEN = $token
  Write-EnvToken $token

  # notebook 的 token：缺了才生成（与 start.sh 同一判据）。每次换 token 而容器还是旧的那个在跑，
  # entrypoint 里的 jupyter 与 .env 就各拿一份 → 打印出来的 URL 打不开。
  $jupyter = Read-EnvJupyterToken
  if (-not $jupyter) {
    # start.sh 那边是 urandom→base64→tr 取 24 位 [A-Za-z0-9]；PS 5.1 没有对等的简单写法，
    # 用桥同样的 GUID idiom 截到 24 位，字符集一致（都是 [a-f0-9]），熵远超本机 token 的需要。
    $jupyter = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')).Substring(0, 24)
    Write-EnvJupyterToken $jupyter
    Write-Host '[arena] 已生成 notebook 的 Jupyter token（.env → ARENA_JUPYTER_TOKEN）' -ForegroundColor Cyan
  }
  # 以 .env 为准导出：compose 的 ${VAR:-} 插值里进程环境优先于 .env 文件
  $env:ARENA_JUPYTER_TOKEN = $jupyter

  New-Item -ItemType Directory -Force -Path data | Out-Null

  $state = Get-BridgeState $token
  if ($state -eq 'ours') {
    Write-Host '[arena] CLI 桥已在运行（:7799 认本次 token，且找得到可跑的 CLI）' -ForegroundColor Cyan
    return
  }
  if ($state -eq 'stale' -or $state -eq 'blind') {
    # 两种状态症状相同（评分一路降级 manual）、处置相同（换掉它）
    $why = if ($state -eq 'stale') { 'token 与本次不一致' } else { '一个可跑的 CLI 都找不到（多半是它的 PATH 残缺）' }
    Write-Host "[arena] CLI 桥在 :7799，但$why → 重启桥" -ForegroundColor Yellow
    Stop-Bridge
    if (-not (Stop-BridgeOnPort)) {
      Write-Host '[arena] 没能结束 :7799 上的旧桥，请手动结束它再跑（留着它评分会一路降级成人工自检表）' -ForegroundColor Red
      exit 1
    }
  } elseif ($state -eq 'foreign') {
    Write-Host '[arena] :7799 被不是 CLI 桥的服务占着 → 不去动它，请自行腾出端口（否则主观题评分会一路降级 manual）' -ForegroundColor Red
    exit 1
  }
  Write-TextFile 'data\llm-bridge.token' $token
  $p = Start-Process -FilePath node -ArgumentList 'scripts/llm-bridge.mjs' `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput 'data\llm-bridge.log' -RedirectStandardError 'data\llm-bridge.err.log'
  Write-TextFile $BridgePidFile "$($p.Id)"
  # 起没起成功不能靠 sleep 猜：端口被"旧桥"占着时新进程会 EADDRINUSE 秒退，
  # 而判据必须是 ours（认 token 且能评分），不能只看它回了 200。
  for ($i = 0; $i -lt 8; $i++) {
    if ((Get-BridgeState $token) -eq 'ours') {
      Write-Host '[arena] CLI 桥已就绪（:7799，日志 data\llm-bridge.log + data\llm-bridge.err.log）' -ForegroundColor Cyan
      return
    }
    Start-Sleep -Seconds 1
  }
  Write-Host '[arena] CLI 桥没能就绪（:7799）。多半是端口被旧进程占着且 token 不一致' -ForegroundColor Red
  # 真正的死因几乎都在 stderr（EADDRINUSE、qodercli 找不到、token 校验失败），
  # 而 Start-Process 是后台启动、控制台上看不到 —— 不打印就等于让人去猜。
  foreach ($log in 'data\llm-bridge.err.log', 'data\llm-bridge.log') {
    if (Test-Path $log) {
      Write-Host "----- 最近 20 行 $log -----" -ForegroundColor Yellow
      Get-Content $log -Tail 20 | ForEach-Object { Write-Host $_ }
    }
  }
  exit 1
}

function Stop-Bridge {
  if (Test-Path $BridgePidFile) {
    $pid_ = (Get-Content $BridgePidFile).Trim()
    # 与 start.sh 的 `kill ... && say "已停止"` 对齐：进程早就不在了就别谎报"已停止"
    $alive = $null
    if ($pid_) { $alive = Get-Process -Id $pid_ -ErrorAction SilentlyContinue }
    if ($alive) { Stop-Process -Id $pid_ -Force -ErrorAction SilentlyContinue }
    Remove-Item $BridgePidFile, $BridgeTokenFile -Force -ErrorAction SilentlyContinue
    if ($alive) { Write-Host '[arena] CLI 桥已停止' -ForegroundColor Cyan }
  }
}

function Wait-Healthy([int]$Seconds = 180) {
  Write-Host "[arena] 等待 $Health 就绪（最长 ${Seconds}s）" -ForegroundColor Cyan
  for ($i = 0; $i -lt $Seconds; $i++) {
    try {
      Invoke-RestMethod -Uri $Health -TimeoutSec 3 | Out-Null
      Write-Host '[arena] 已就绪 -> http://localhost:7788' -ForegroundColor Green
      return
    } catch { Start-Sleep -Seconds 1 }
  }
  Write-Host '[arena] 健康检查超时，执行 .\start.ps1 -Logs 查原因' -ForegroundColor Red
  exit 1
}

# 用系统默认浏览器打开（默认是 Edge 就走 Edge，不钦定 Chrome）。$env:ARENA_NO_BROWSER=1 可跳过。
function Open-DefaultBrowser([string]$Url = 'http://localhost:7788') {
  if ($env:ARENA_NO_BROWSER -eq '1') { return }
  try { Start-Process $Url } catch { Write-Host "[arena] 自动打开失败，请手动访问 $Url" -ForegroundColor Yellow }
}

# 闸门没接上才提示。两条路都算数：core.hooksPath 指到 .githooks，或直接装在 .git/hooks/pre-commit
# （WI-39 的实际落地方式是后者）—— 只认前者的话，这个提示会一直说假话。
function Warn-MissingHooks {
  $path = ''
  try { $path = (git config --get core.hooksPath) } catch { $path = '' }
  $installed = '.git\hooks\pre-commit'
  try { $installed = (git rev-parse --git-path hooks/pre-commit) } catch { }
  if ($path -eq '.githooks' -or (Test-Path $installed)) { return }
  $shown = if ([string]::IsNullOrEmpty($path)) { '未设置' } else { $path }
  Write-Host "[arena] 提示：提交前自动校验没生效（core.hooksPath=$shown，且 $installed 不存在）。要接上：npm run hooks:install" -ForegroundColor Yellow
}

# 健康检查过了 ≠ 什么都能干：评分链不可用会让主观题静默降级成人工自检表（本项目反复出现的故障）。
function Report-Health {
  try { $h = Invoke-RestMethod -Uri $Health -TimeoutSec 5 } catch {
    Write-Host '[arena] 读不到 /api/health，执行 .\start.ps1 -Logs 查原因' -ForegroundColor Red
    return
  }
  $pairs = @()
  $h.stacks.PSObject.Properties | ForEach-Object { $pairs += "$($_.Name):$($_.Value)" }
  Write-Host "[arena] 判题栈：$($pairs -join ',')" -ForegroundColor Cyan
  if ($h.stacks.'llm-rubric' -eq $false) {
    Write-Host '[arena] 主观题评分链此刻不可用 → 会降级成人工自检表。看 data\llm-bridge.log，并确认宿主桥在 :7799（start.ps1 会自己拉）' -ForegroundColor Red
  }
}

# notebook 的入口要说给人看，但要说的是事实（与 start.sh 的 report_notebook 同判据）：
# ① 不打印 token —— 旧注释那句"只打印到终端、不写进任何日志文件"在整个 run 被重定向时是假的；
# ② 先探端口再报 —— "端口上真正应答的那个进程才是事实"（Get-BridgeState 的注释），
#    探测故意不带 token：有任何 HTTP 应答就说明 7789 上确实有进程在听。它证明的是"有人在听"，
#    不是"那是 jupyter 且 token 对得上"—— 后者归 Task 7 的 /api/notebook/status。
# -Dev 分支不走这里：dev 服务故意不发布 notebook 端口，打印出来就是个打不开的地址（说假话）。
function Report-Notebook {
  $token = Read-EnvJupyterToken
  if (-not $token) {
    Write-Host '[arena] Notebook 未就绪：.env 里没有 ARENA_JUPYTER_TOKEN（.\start.ps1 首启会生成）' -ForegroundColor Yellow
    return
  }
  $code = 0
  try {
    $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:7789/login' -TimeoutSec 2 -UseBasicParsing
    $code = [int]$resp.StatusCode
  } catch {
    # 非 2xx 也算"有进程应答"（与 start.sh 那边 curl 只看 http_code 同判据）；完全没有连接才是没起来。
    $r = $_.Exception.Response
    if ($r) { $code = [int]$r.StatusCode }
  }
  if ($code -eq 0) {
    Write-Host '[arena] Notebook 未就绪：7789 上没有 HTTP 应答 ⇒ 容器里的 jupyter 没起来（缺 token / 镜像还是没带 Jupyter 的旧版）。看 .\start.ps1 -Logs 里 entrypoint 那几行，必要时 .\start.ps1 -Rebuild' -ForegroundColor Yellow
    return
  }
  Write-Host "[arena] Notebook -> http://127.0.0.1:7789/tree（7789 已应答 HTTP $code；token 在 .env 的 ARENA_JUPYTER_TOKEN，页面第五项 Notebook 也能拿到）只打印一次，且不含 token" -ForegroundColor Cyan
}

if ($Down) {
  docker compose --profile e2e stop e2e 2>$null
  Stop-Bridge
  docker compose down
  exit
}
if ($Logs) { docker compose logs -f arena; exit }
if ($BridgeLogs) { Get-Content 'data\llm-bridge.log' -Wait -Tail 60; exit }
if ($Status) { docker compose ps; exit }
if ($Verify) {
  # **先起新代码，再验**（与 start.sh --verify 同一判据）：`docker compose exec` 进的是当前跑着的
  # 容器，而它用的是被创建时那个镜像 —— 只 build 不 up -d 等于验旧代码。
  Start-Bridge
  Invoke-Step '镜像构建' { docker compose build --pull=false }
  Invoke-Step '启动容器' { docker compose up -d arena }
  Wait-Healthy 180
  # start.sh 的 --verify 走 start_app ⇒ 健康栈、notebook、hook 提示三条都会打。
  # 这里以前一个都不打：同一套判据的两个实现在"最容易被 agent/CI 调用那条路径"上说了不同的话，
  # 而 --verify 恰恰是判题相关改动默认要跑的那条 —— notebook 没起来时它会看起来一切正常。
  Report-Health
  Report-Notebook
  Warn-MissingHooks
  # 与 start.sh 同一判据：容器里没有 docker，E2E 起不了隔离实例，必须 SKIP_E2E=1，
  # 否则 --verify 会在最后一个阶段必挂（判题矩阵其实已经跑完）。
  Write-Host '[arena] 容器内验证跳过 E2E（容器里起不了隔离实例）；E2E 请在宿主跑：npm run e2e（用 Edge 验你真正看的界面）' -ForegroundColor Cyan
  # ARENA_REQUIRE_STACKS=1：栈不齐时矩阵会静默跳过那些题（历史上用 tools 容器跑就是这样），
  # 带上它跳过即判红。与 start.sh 同一条判据。
  docker compose exec -T -e SKIP_E2E=1 -e ARENA_REQUIRE_STACKS=1 arena npm run verify --silent
  exit
}
if ($E2E) {
  if ($InContainer) {
    Write-Host '[arena] 容器内跑 E2E：装的是 bundled Chromium，验的不是你日常看的 Edge' -ForegroundColor Yellow
    docker compose exec -T -e PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 -e ARENA_E2E_BASE=http://127.0.0.1:7788 arena bash -lc 'npx playwright install chromium && npm run e2e'
  } else {
    Write-Host '[arena] E2E 请直接在宿主机跑：npm run e2e' -ForegroundColor Cyan
    Write-Host '[arena]   它会自己起隔离实例（127.0.0.1:7798、data/e2e、题库只读），并用默认浏览器 Edge 验你真正看到的界面' -ForegroundColor Cyan
    Write-Host '[arena]   确实要在容器里跑：.\start.ps1 -E2E -InContainer' -ForegroundColor Cyan
  }
  exit
}

Start-Bridge
if ($Rebuild) { Invoke-Step '镜像重建' { docker compose build --pull=false --no-cache } }
else { Invoke-Step '镜像构建' { docker compose build --pull=false } }

if ($Dev) {
  Invoke-Step '启动 dev' { docker compose --profile dev up -d dev }
  Write-Host '[arena] 开发模式 -> http://localhost:5173 （后端 http://localhost:7788）' -ForegroundColor Green
  Warn-MissingHooks
  Open-DefaultBrowser 'http://localhost:5173'
  exit
}

Invoke-Step '启动容器' { docker compose up -d arena }
Wait-Healthy 180
Report-Health
Report-Notebook
Warn-MissingHooks
if ($Ide) {
  # 网页 IDE 与做题系统共用同一个容器、同一个服务，所以"独立启动"只是换个落地页
  # （与 start.sh 的 --ide 同一判据）。
  Write-Host '[arena] 网页 IDE -> http://localhost:7788/#/ide （这里不记分、不留提交历史）' -ForegroundColor Green
  Open-DefaultBrowser 'http://localhost:7788/#/ide'
} else {
  Open-DefaultBrowser
}
