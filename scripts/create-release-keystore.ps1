param(
    [string]$KeyAlias = "zalo-auto-reply"
)

$ErrorActionPreference = "Stop"
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$androidDir = Join-Path $workspaceRoot "android"
$signingDir = Join-Path $androidDir "signing"
$keystorePath = Join-Path $signingDir "zalo-auto-reply-release.jks"
$propertiesPath = Join-Path $androidDir "signing.properties"

if ((Test-Path -LiteralPath $keystorePath) -or (Test-Path -LiteralPath $propertiesPath)) {
    throw "Release signing files already exist. Refusing to replace the long-term signing key."
}

$keytoolPath = (Get-Command keytool.exe -ErrorAction SilentlyContinue).Source
if (-not $keytoolPath -and $env:JAVA_HOME) {
    $candidate = Join-Path $env:JAVA_HOME "bin\keytool.exe"
    if (Test-Path -LiteralPath $candidate) { $keytoolPath = $candidate }
}
if (-not $keytoolPath) {
    $keytoolPath = Get-ChildItem -LiteralPath (Join-Path $env:ProgramFiles "Java") -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending |
        ForEach-Object { Join-Path $_.FullName "bin\keytool.exe" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
}
if (-not $keytoolPath) {
    throw "keytool.exe was not found. Install JDK 21 and ensure its bin directory is on PATH."
}

New-Item -ItemType Directory -Path $signingDir -Force | Out-Null
$randomBytes = New-Object byte[] 32
$randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $randomGenerator.GetBytes($randomBytes)
} finally {
    $randomGenerator.Dispose()
}
$password = -join ($randomBytes | ForEach-Object { $_.ToString("x2") })

& $keytoolPath `
    -genkeypair `
    -alias $KeyAlias `
    -keyalg RSA `
    -keysize 4096 `
    -sigalg SHA256withRSA `
    -validity 36500 `
    -storetype PKCS12 `
    -keystore $keystorePath `
    -storepass $password `
    -keypass $password `
    -dname "CN=Zalo Auto Reply, OU=Mobile, O=Private, L=Ha Noi, ST=Ha Noi, C=VN" `
    -noprompt

if ($LASTEXITCODE -ne 0) {
    throw "keytool failed with exit code $LASTEXITCODE."
}

$properties = @(
    "storeFile=signing/zalo-auto-reply-release.jks"
    "storePassword=$password"
    "keyAlias=$KeyAlias"
    "keyPassword=$password"
) -join "`n"
[IO.File]::WriteAllText($propertiesPath, "$properties`n", [Text.UTF8Encoding]::new($false))

if ($env:OS -eq "Windows_NT") {
    & icacls.exe $keystorePath "/inheritance:r" "/grant:r" "${env:USERNAME}:(F)" | Out-Null
    & icacls.exe $propertiesPath "/inheritance:r" "/grant:r" "${env:USERNAME}:(F)" | Out-Null
}

Write-Host "Created long-term release keystore: $keystorePath"
Write-Host "Created ignored signing configuration: $propertiesPath"
Write-Host "Back up both files now. The password is intentionally not printed."
