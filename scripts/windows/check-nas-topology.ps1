[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Path,

    [switch]$ProbeWrite,

    [switch]$Watch,

    [ValidateRange(1, 60)]
    [int]$IntervalSeconds = 5,

    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 8
)

$ErrorActionPreference = "Stop"
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Invoke-NasProbe {
    param(
        [string]$ProbePath,
        [bool]$DoWrite
    )

    $startedAt = Get-Date
    try {
        if (-not (Test-Path -LiteralPath $ProbePath -PathType Container)) {
            return [pscustomobject]@{
                online = $false
                readable = $false
                enumerable = $false
                writable = $false
                message = "Path is missing or is not a directory"
            }
        }

        $items = @(Get-ChildItem -LiteralPath $ProbePath -Force -ErrorAction Stop)
        $writable = $null
        $writeMessage = "write probe skipped"
        if ($DoWrite) {
            $probeName = ".willard-nas-probe-" + [guid]::NewGuid().ToString("N") + ".tmp"
            $probeFile = Join-Path -Path $ProbePath -ChildPath $probeName
            try {
                [System.IO.File]::WriteAllText($probeFile, "Willard NAS access probe")
                Remove-Item -LiteralPath $probeFile -Force -ErrorAction Stop
                $writable = $true
                $writeMessage = "write and delete passed"
            } catch {
                if (Test-Path -LiteralPath $probeFile) {
                    Remove-Item -LiteralPath $probeFile -Force -ErrorAction SilentlyContinue
                }
                $writable = $false
                $writeMessage = "write probe failed: " + $_.Exception.Message
            }
        }

        return [pscustomobject]@{
            online = $true
            readable = $true
            enumerable = $true
            writable = $writable
            itemCount = $items.Count
            message = "read and list passed; " + $writeMessage
            elapsedMs = [int]((Get-Date - $startedAt).TotalMilliseconds)
        }
    } catch {
        return [pscustomobject]@{
            online = $false
            readable = $false
            enumerable = $false
            writable = $false
            message = $_.Exception.Message
            elapsedMs = [int]((Get-Date - $startedAt).TotalMilliseconds)
        }
    }
}

function Get-NasProbe {
    $job = Start-Job -ScriptBlock ${function:Invoke-NasProbe} -ArgumentList $Path, [bool]$ProbeWrite
    try {
        if (Wait-Job -Job $job -Timeout $TimeoutSeconds) {
            $result = Receive-Job -Job $job
            if ($null -ne $result) {
                return $result
            }
        } else {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            return [pscustomobject]@{
                online = $false
                readable = $false
                enumerable = $false
                writable = $false
                message = "Probe timed out after $TimeoutSeconds seconds"
            }
        }
    } finally {
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{
        online = $false
        readable = $false
        enumerable = $false
        writable = $false
        message = "Probe returned no result"
    }
}

$previousState = $null
do {
    $probe = Get-NasProbe
    $state = if ($probe.online) { "online" } else { "offline" }
    if ($null -ne $previousState -and $previousState -ne $state) {
        Write-Host ("STATE CHANGE: {0} -> {1}" -f $previousState, $state) -ForegroundColor Yellow
    }
    $previousState = $state

    [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        identity = $identity
        path = $Path
        state = $state
        online = $probe.online
        readable = $probe.readable
        enumerable = $probe.enumerable
        writable = $probe.writable
        itemCount = $probe.itemCount
        message = $probe.message
        elapsedMs = $probe.elapsedMs
    } | ConvertTo-Json -Compress

    if ($Watch) {
        Start-Sleep -Seconds $IntervalSeconds
    }
} while ($Watch)