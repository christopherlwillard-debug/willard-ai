# Serialize installed-launcher startup within the current Windows logon session.
# The caller holds the returned Mutex until startup has either reused the
# existing services, completed a fresh start, or failed and reported diagnostics.
function Enter-WillardLauncherMutex {
  [CmdletBinding()]
  param(
    [string]$Name = "Local\WillardMediaCenter.Launcher.v1",
    [ValidateRange(1, 600000)]
    [int]$TimeoutMilliseconds = 300000
  )

  if ([string]::IsNullOrWhiteSpace($Name)) {
    throw "The Willard launcher mutex name is empty."
  }

  $mutex = [System.Threading.Mutex]::new($false, $Name)
  try {
    $acquired = $false
    try {
      $acquired = $mutex.WaitOne($TimeoutMilliseconds)
    } catch [System.Threading.AbandonedMutexException] {
      # The previous launcher process exited while owning the mutex. Windows
      # grants ownership to this waiter; continue into normal journal recovery.
      $acquired = $true
    }

    if (-not $acquired) {
      throw [System.TimeoutException]::new(
        "Another Willard startup is still in progress. Wait a moment and try again."
      )
    }
    return $mutex
  } catch {
    $mutex.Dispose()
    throw
  }
}

function Exit-WillardLauncherMutex {
  [CmdletBinding()]
  param([System.Threading.Mutex]$Mutex)

  if (-not $Mutex) { return }
  try {
    $Mutex.ReleaseMutex()
  } catch {
    # Process termination also releases an abandoned Windows mutex.
  } finally {
    $Mutex.Dispose()
  }
}
