/**
 * The call watcher on Windows (#208), run by the system's own PowerShell, so IncarnaMind ships no
 * program of its own to sign for it. It reads the record Windows keeps of each app's microphone
 * use, which Settings › Privacy › Microphone shows: an app whose last use has a start and no stop
 * is using it now. Every 2 seconds it prints {"apps":[...]} when that changed, each app by the
 * name Windows keeps it under, and it exits once IncarnaMind's process is gone.
 */
export const WINDOWS_POLL_SECONDS = 2;

export function windowsWatchScript(parentPid: number): string {
  if (!Number.isInteger(parentPid) || parentPid <= 0)
    throw new Error("A parent process id is needed.");
  return `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$path = 'Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone'
function InUse($key) {
  $start = $key.GetValue('LastUsedTimeStart', $null)
  $stop = $key.GetValue('LastUsedTimeStop', $null)
  return ($null -ne $start) -and ([int64]$start -ne 0) -and ($null -ne $stop) -and ([int64]$stop -eq 0)
}
function Users() {
  $found = New-Object System.Collections.Generic.List[string]
  $microphone = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($path)
  if ($null -eq $microphone) { return $found }
  foreach ($name in $microphone.GetSubKeyNames()) {
    $key = $microphone.OpenSubKey($name)
    if ($null -eq $key) { continue }
    if ($name -eq 'NonPackaged') {
      foreach ($program in $key.GetSubKeyNames()) {
        $each = $key.OpenSubKey($program)
        if ($null -ne $each) { if (InUse $each) { $found.Add($program) }; $each.Close() }
      }
    } elseif (InUse $key) { $found.Add($name) }
    $key.Close()
  }
  $microphone.Close()
  return $found
}
$last = ''
while ($true) {
  try { [void][System.Diagnostics.Process]::GetProcessById(${parentPid}) } catch { exit 0 }
  $names = @(Users | ForEach-Object { '"' + ($_ -replace '\\\\', '\\\\' -replace '"', '\\"') + '"' })
  $line = '{"apps":[' + ($names -join ',') + ']}'
  if ($line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }
  Start-Sleep -Seconds ${WINDOWS_POLL_SECONDS}
}
`;
}
