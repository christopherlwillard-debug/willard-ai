$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "..\launcher\common.ps1")

$tempRoot = Join-Path $env:TEMP ("willard-developer-process-ownership-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
$script:LogDir = $tempRoot
$script:PidFile = Join-Path $tempRoot "willard.pids.json"
$script:MockListeners = @()
$script:MockPortQueryFails = $false
$script:MockNoMatchingInstances = $false

function Get-NetTCPConnection {
    [CmdletBinding()]
    param([int]$LocalPort, [string]$State)
    if ($script:MockPortQueryFails) { throw "synthetic TCP query failure" }
    if ($script:MockNoMatchingInstances) {
        $exception = [System.Management.Automation.ItemNotFoundException]::new("No matching listener objects")
        $record = [System.Management.Automation.ErrorRecord]::new(
            $exception,
            "NoMatchingInstances",
            [System.Management.Automation.ErrorCategory]::ObjectNotFound,
            $LocalPort
        )
        $PSCmdlet.ThrowTerminatingError($record)
    }
    return @($script:MockListeners | Where-Object { $_.LocalPort -eq $LocalPort })
}

function Test-ProcessIdentity($tracked) {
    return $false
}

function Assert-Throws([scriptblock]$Action, [string]$Expected) {
    $thrown = $false
    try { & $Action } catch {
        $thrown = $true
        if ($_.Exception.Message -notmatch [regex]::Escape($Expected)) {
            throw "Expected error containing '$Expected' but received '$($_.Exception.Message)'."
        }
    }
    if (-not $thrown) { throw "Expected operation to fail with '$Expected'." }
}

try {
    Write-Host "Testing clean startup when Windows reports no matching listener objects..."
    $script:MockNoMatchingInstances = $true
    Assert-NoUntrackedDeveloperServices $null
    $script:MockNoMatchingInstances = $false

    Write-Host "Testing missing journal with an API listener..."
    $script:MockListeners = @([pscustomobject]@{ LocalPort = 8080; OwningProcess = 4101 })
    Assert-Throws { Assert-NoUntrackedDeveloperServices $null } "missing or incomplete"
    Assert-Throws { Stop-TrackedProcesses } "missing or incomplete"

    Write-Host "Testing partial journal with a web listener..."
    $partial = [pscustomobject]@{
        version = 2
        runToken = "synthetic-run"
        api = [pscustomobject]@{ pid = 4102 }
        web = $null
    }
    $script:MockListeners = @([pscustomobject]@{ LocalPort = 5000; OwningProcess = 4103 })
    Assert-Throws { Assert-NoUntrackedDeveloperServices $partial } "missing or incomplete"

    Write-Host "Testing listener-query failure..."
    $script:MockListeners = @()
    $script:MockPortQueryFails = $true
    Assert-Throws { Assert-NoUntrackedDeveloperServices $null } "could not verify"
    $script:MockPortQueryFails = $false

    Write-Host "Testing that a surviving listener preserves the process journal..."
    @{
        version = 2
        runToken = "synthetic-run"
        api = @{
            pid = 4104
            path = "C:\\Willard\\node.exe"
            commandLine = "node api.mjs"
            creationDate = "20261106000000.000000+000"
        }
        web = @{
            pid = 4105
            path = "C:\\Willard\\node.exe"
            commandLine = "node vite.js"
            creationDate = "20261106000001.000000+000"
        }
        startedAt = (Get-Date).ToString("o")
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $script:PidFile -Encoding UTF8
    $script:MockListeners = @([pscustomobject]@{ LocalPort = 5000; OwningProcess = 4106 })
    Assert-Throws { Stop-TrackedProcesses } "process list was retained"
    if (-not (Test-Path -LiteralPath $script:PidFile)) {
        throw "The process journal was deleted while a service port still had a listener."
    }

    Write-Host "Developer process ownership smoke passed."
} finally {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
