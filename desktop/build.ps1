param([switch]$Package, [switch]$SkipCompile, [string]$LauncherOutput)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler not found.' }
$exe = if ($LauncherOutput) { [IO.Path]::GetFullPath($LauncherOutput) } else { Join-Path $root 'ScoreStudio.exe' }
New-Item -ItemType Directory -Path (Split-Path $exe -Parent) -Force | Out-Null
if (!$SkipCompile) {
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /out:$exe /win32icon:$(Join-Path $root 'assets\app.ico') (Join-Path $PSScriptRoot 'Launcher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed' }
} elseif (!(Test-Path -LiteralPath $exe)) { throw 'Cannot skip compilation: existing EXE is missing.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$bin = Join-Path $root 'bin'
New-Item -ItemType Directory -Path $bin -Force | Out-Null
$bundledNode = Join-Path $bin 'node.exe'
if (!(Test-Path -LiteralPath $bundledNode) -or (Get-FileHash -LiteralPath $nodePath).Hash -ne (Get-FileHash -LiteralPath $bundledNode).Hash) {
    Copy-Item -LiteralPath $nodePath -Destination $bundledNode -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'LICENSE-node.txt') -Destination (Join-Path $bin 'LICENSE-node.txt') -Force
if ($Package) {
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $name = 'score-studio-desktop-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.zip'
    $output = Join-Path (Split-Path $root -Parent) $name
    $files = @('ScoreStudio.exe','index.html','app.js','core.js','style.css','README.md','install-autohotkey.ps1',
        'installers\AutoHotkey_2.0.26.zip',
        'bin\node.exe','bin\LICENSE-node.txt','desktop\server.js','desktop\github.js','desktop\library.js','desktop\artifacts.js','desktop\contributions.js','assets\app.ico','assets\icon.png')
    if ((Test-Path -LiteralPath (Join-Path $root '.git')) -and (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        # Do not publish untracked personal scores in the application release.
        $tracked = & git.exe -C $root -c core.quotepath=false ls-files -- 'scores/*.score.json'
        if ($LASTEXITCODE -ne 0) { throw 'Cannot enumerate published scores.' }
        $files += $tracked | ForEach-Object { $_.Replace('/', '\') }
    } else {
        $files += Get-ChildItem -LiteralPath (Join-Path $root 'scores') -File -Filter '*.score.json' | ForEach-Object { 'scores\' + $_.Name }
    }
    $files += Get-ChildItem -LiteralPath $root -File -Filter '*.cmd' | ForEach-Object { $_.Name }
    $files += Get-ChildItem -LiteralPath (Join-Path $root 'installers') -File -Filter '*.txt' | ForEach-Object { 'installers\' + $_.Name }
    $zip = [IO.Compression.ZipFile]::Open($output, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            $source = if ($file -eq 'ScoreStudio.exe') { $exe } else { Join-Path $root $file }
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $source,
                ('score-studio/' + $file.Replace('\','/')), [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    Write-Output $output
}
Write-Output $exe
