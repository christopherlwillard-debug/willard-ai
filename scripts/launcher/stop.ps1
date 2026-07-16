# Stop Willard AI — stops only what the launcher started.
. (Join-Path $PSScriptRoot "common.ps1")

Assert-LocalWindows

Write-Banner "Stopping..."

$stopped = Stop-TrackedProcesses
if ($stopped -gt 0) {
    Write-Ok "Willard AI has been stopped."
} else {
    Write-Info "Willard AI wasn't running (nothing to stop)."
}
Pause-BeforeClose
exit 0
