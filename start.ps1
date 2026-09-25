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

function Read-EnvToken {
  if (Test-Path $EnvFile) {
    $line = Select-String -Path $EnvFile -Pattern '^ARENA_LLM_BRIDGE_TOKEN=' | Select-Object -Last 1
    if ($line) { return ($line.Line -split '=', 2)[1] }
  }
  return ''
}

function Write-EnvToken([string]$token) {
  if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Path $EnvFile | Out-Null }
  $kept = @(Get-Content $EnvFile | Where-Object { $_ -notmatch '^ARENA_LLM_BRIDGE_TOKEN=' })
  # 显式 UTF-8 无 BOM + LF：compose 读 .env 时 BOM 会让第一行的键名多个隐形字符，CRLF 会把 \r 带进 token
  [System.IO.File]::WriteAllText($EnvFile, (($kept + "ARENA_LLM_BRIDGE_TOKEN=$token") -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
}

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
Warn-MissingHooks
if ($Ide) {
  # 网页 IDE 与做题系统共用同一个容器、同一个服务，所以"独立启动"只是换个落地页
  # （与 start.sh 的 --ide 同一判据）。
  Write-Host '[arena] 网页 IDE -> http://localhost:7788/#/ide （这里不记分、不留提交历史）' -ForegroundColor Green
  Open-DefaultBrowser 'http://localhost:7788/#/ide'
} else {
  Open-DefaultBrowser
}
