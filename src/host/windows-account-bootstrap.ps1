param(
  [Parameter(Mandatory=$true)][string]$Directory,
  [Parameter(Mandatory=$true)][string]$RuntimePath,
  [Parameter(Mandatory=$true)][string]$LaunchPath,
  [Parameter(Mandatory=$true)][string]$ArgumentsBase64
)
$ErrorActionPreference = 'Stop'
# A console-subsystem root is necessary: Electron's GUI executable can attach
# to a different parent console even with ELECTRON_RUN_AS_NODE. Do not run any
# native CLI until this exact PowerShell root and its console belong to the Job.
$pidFile=Join-Path $Directory 'pid'
[System.IO.File]::WriteAllText(($pidFile+'.tmp'),[string]$PID)
[System.IO.File]::Move(($pidFile+'.tmp'),$pidFile)
[Console]::Out.Write(([char]27).ToString()+'[0m')
$until=[DateTime]::UtcNow.AddSeconds(15)
while (!(Test-Path -LiteralPath (Join-Path $Directory 'ready'))) {
  if ([DateTime]::UtcNow -ge $until) { exit 1 }
  Start-Sleep -Milliseconds 20
}
if (!(Test-Path -LiteralPath (Join-Path $Directory 'cancel')) -and !(Test-Path -LiteralPath (Join-Path $Directory 'stop'))) {
  try {
    # Only fixed paths plus one Base64 JSON value cross PowerShell. The Node
    # helper decodes the original argv and spawns it as an array, never a shell.
    & $RuntimePath $LaunchPath $Directory $ArgumentsBase64
    if (!(Test-Path -LiteralPath (Join-Path $Directory 'exit'))) {
      [System.IO.File]::WriteAllText((Join-Path $Directory 'exit'),'{"exitCode":1,"signal":null}')
    }
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $Directory 'exit'),'{"exitCode":1,"signal":null}')
  }
}
# Host owns disposal, including native exit and startup cancellation paths.
while ($true) { Start-Sleep -Milliseconds 1000 }
