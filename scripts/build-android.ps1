$ErrorActionPreference = "Stop"

if (-not $env:JAVA_HOME) {
  $bundledJdk = Join-Path $env:ProgramFiles "Android\Android Studio\jbr"
  if (Test-Path (Join-Path $bundledJdk "bin\java.exe")) {
    $env:JAVA_HOME = $bundledJdk
  }
}

if (-not $env:ANDROID_HOME) {
  $installedSdk = Join-Path $env:LOCALAPPDATA "Android\Sdk"
  if (Test-Path (Join-Path $installedSdk "platform-tools")) {
    $env:ANDROID_HOME = $installedSdk
  }
}

if (-not $env:ANDROID_HOME) {
  throw "Android SDK was not found. Install Android Studio or set ANDROID_HOME."
}

$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$androidProject = Join-Path $PSScriptRoot "..\android"
& (Join-Path $androidProject "gradlew.bat") -p $androidProject assembleDebug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
