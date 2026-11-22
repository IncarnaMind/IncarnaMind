param(
  [Parameter(Mandatory)] [string] $AppRoot,
  [switch] $Expected,
  [string] $Version
)

$ErrorActionPreference = "Stop"
$helper = Join-Path $AppRoot "resources/call-watcher.exe"
if (-not $Expected) {
  if (Test-Path -LiteralPath $helper) { throw "Call watcher is present in a build that did not request it." }
  return
}
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { throw "The signed app is missing the call watcher." }

$info = (Get-Item -LiteralPath $helper).VersionInfo
if ($info.ProductName -cne "IncarnaMind" -or $info.ProductVersion -cne $Version) {
  throw "The call watcher's product name or version differs from this build."
}

$signature = Get-AuthenticodeSignature -LiteralPath $helper
$signer = $signature.SignerCertificate
if (-not $signer -or -not $signature.TimeStamperCertificate) {
  throw "The call watcher needs a timestamped signature from the Windows app's signer."
}
$app = Get-AuthenticodeSignature -LiteralPath (Join-Path $AppRoot "IncarnaMind.exe")
if ($signer.Thumbprint -ne $app.SignerCertificate.Thumbprint) {
  throw "The call watcher's signer differs from the Windows app's signer."
}

$untrustedRoot = [System.ComponentModel.Win32Exception]::new(-2146762487).Message
if ($signature.Status -eq "Valid") {
  Write-Output "The call watcher's signature is valid."
} elseif ($signer.Subject -eq $signer.Issuer -and $signature.StatusMessage -eq $untrustedRoot) {
  Write-Output "::warning title=Test signature::The call watcher is signed with an untrusted test certificate."
} else {
  throw "The call watcher's signature is invalid: $($signature.StatusMessage)"
}
