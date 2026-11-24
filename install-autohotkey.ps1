param([switch]$PrepareOnly)
$ErrorActionPreference = 'Stop'
try {
    $archive = Join-Path $PSScriptRoot 'installers\AutoHotkey_2.0.26.zip'
    $expected = '7AC947DD0A48C6FD71395C760E4E02B03F3916FB4387BF0416C1D5482E9C3CA8'
    if (!(Test-Path -LiteralPath $archive -PathType Leaf)) { throw 'Bundled AutoHotkey ZIP is missing. Extract the complete application package first.' }
    $actual = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    if ($actual -ne $expected) { throw 'Bundled ZIP checksum mismatch. Installation was not started.' }
    if (!$PrepareOnly) {
        Write-Host 'Score Studio - AutoHotkey v2.0.26 offline setup'
        Write-Host 'This opens the original setup interface. It may install AutoHotkey and register .ahk files.'
        Write-Host 'No silent installation or automatic system changes will be performed.'
        $answer = Read-Host 'Open the installer? Type Y to continue'
        if ($answer -notmatch '^[Yy]$') { Write-Host 'Cancelled.'; exit 0 }
    }
    # Always extract to a fresh directory. Never overwrite a previous runtime.
    $target = Join-Path $PSScriptRoot ('runtime\AutoHotkey_2.0.26-' + [Guid]::NewGuid().ToString('N'))
    $absolute = [IO.Path]::GetFullPath($target)
    $prefix = $absolute.TrimEnd('\') + '\'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($entry in $zip.Entries) {
            $destination = [IO.Path]::GetFullPath((Join-Path $absolute $entry.FullName))
            if (!$destination.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -and $destination -ne $absolute) {
                throw 'Unsafe ZIP entry. Installation was not started.'
            }
        }
    } finally { $zip.Dispose() }
    New-Item -ItemType Directory -Path $absolute -Force | Out-Null
    Expand-Archive -LiteralPath $archive -DestinationPath $absolute
    $installerRoot = Join-Path $absolute 'AutoHotkey_2.0.26'
    $exe = Join-Path $installerRoot 'AutoHotkey32.exe'
    $setup = Join-Path $installerRoot 'UX\ui-setup.ahk'
    foreach ($file in @($exe, $setup, (Join-Path $installerRoot 'license.txt'), (Join-Path $installerRoot 'Install.cmd'))) {
        if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Incomplete AutoHotkey installation package.' }
    }
    Write-Host ('Prepared original installer in: ' + $installerRoot)
    if ($PrepareOnly) { Write-Output $installerRoot; exit 0 }
    Start-Process -FilePath $exe -ArgumentList ('"' + $setup + '"') -WindowStyle Hidden | Out-Null
    Write-Host 'The original AutoHotkey setup window is opening. Complete or cancel installation there.'
} catch {
    Write-Host ('Setup was not completed: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'If local PowerShell policy blocks this helper, extract installers\AutoHotkey_2.0.26.zip manually and run Install.cmd.'
    exit 1
}
