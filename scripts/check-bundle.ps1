# Windows half of check-bundle.sh: the app is named "Set" and `set-mcp.exe` shipped beside it.
# Installers are unpacked, not run: `msiexec /a` for the .msi, 7-Zip for the NSIS .exe.
# Usage: pwsh scripts/check-bundle.ps1 <bundle-dir>

param(
  [Parameter(Mandatory = $true)][string]$BundleDir
)

$ErrorActionPreference = 'Stop'

# `::error::` is a GitHub Actions annotation.
function Fail($message) {
  Write-Output "::error::$message"
  exit 1
}

# `tauri-build` stamps `productName` into the version resource; it is what Task Manager shows.
function Assert-NamedSet($exePath, $origin) {
  $info = (Get-Item $exePath).VersionInfo
  if ($info.ProductName -ne 'Set') {
    Fail "$origin`: set.exe reports ProductName '$($info.ProductName)', not 'Set'."
  }
  if ($info.FileDescription -ne 'Set') {
    Fail "$origin`: set.exe reports FileDescription '$($info.FileDescription)', not 'Set'."
  }
}

function Find-One($root, $name) {
  Get-ChildItem -Path $root -Filter $name -Recurse -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
}

$checked = 0
$work = Join-Path ([System.IO.Path]::GetTempPath()) "set-bundle-check-$PID"
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
  $nsis = Get-ChildItem -Path (Join-Path $BundleDir 'nsis') -Filter '*-setup.exe' `
    -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($nsis) {
    $out = Join-Path $work 'nsis'
    & 7z x "-o$out" $nsis.FullName -y | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "failed to read $($nsis.Name) with 7-Zip." }

    $server = Find-One $out 'set-mcp.exe'
    if (-not $server) { Fail "set-mcp.exe is missing from $($nsis.Name)." }
    $app = Find-One $out 'set.exe'
    if (-not $app) { Fail "set.exe is missing from $($nsis.Name)." }
    Assert-NamedSet $app.FullName $nsis.Name

    Write-Output "ok: $($nsis.Name) ships set.exe + set-mcp.exe and names the app 'Set'"
    $checked++
  }

  $msi = Get-ChildItem -Path (Join-Path $BundleDir 'msi') -Filter '*.msi' `
    -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($msi) {
    $out = Join-Path $work 'msi'
    New-Item -ItemType Directory -Path $out -Force | Out-Null
    # /a unpacks to TARGETDIR without installing.
    $proc = Start-Process msiexec.exe -Wait -PassThru -ArgumentList @(
      '/a', "`"$($msi.FullName)`"", '/qn', "TARGETDIR=`"$out`""
    )
    if ($proc.ExitCode -ne 0) {
      Fail "msiexec failed to unpack $($msi.Name) (exit $($proc.ExitCode))."
    }

    $server = Find-One $out 'set-mcp.exe'
    if (-not $server) { Fail "set-mcp.exe is missing from $($msi.Name)." }
    $app = Find-One $out 'set.exe'
    if (-not $app) { Fail "set.exe is missing from $($msi.Name)." }
    Assert-NamedSet $app.FullName $msi.Name

    Write-Output "ok: $($msi.Name) ships set.exe + set-mcp.exe and names the app 'Set'"
    $checked++
  }
}
finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

if ($checked -eq 0) {
  Fail "no installers found under $BundleDir; nothing was checked."
}
