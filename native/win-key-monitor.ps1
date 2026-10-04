# opennib push-to-talk key watcher for Windows.
#
# Polls one virtual key with GetAsyncKeyState and prints "DOWN" / "UP" lines,
# the same protocol as the macOS fn-key-monitor helper. Polling a single key
# needs no keyboard hook, so unlike hook-based helpers it is not flagged by
# Windows Defender as a keylogger. Exits when the parent process goes away.
param(
  [Parameter(Mandatory = $true)][string]$Combo,
  [int]$ParentPid = 0
)
$ErrorActionPreference = "Stop"

$vk = switch ($Combo) {
  "LeftCtrl"   { 0xA2 }
  "RightCtrl"  { 0xA3 }
  "LeftAlt"    { 0xA4 }
  "RightAlt"   { 0xA5 }
  "ScrollLock" { 0x91 }
  "F8"         { 0x77 }
  "F9"         { 0x78 }
  default      { [Console]::Error.WriteLine("unsupported combo: $Combo"); exit 2 }
}

Add-Type -Namespace Opennib -Name Keys -MemberDefinition @"
[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
"@

$out = [Console]::Out
$out.WriteLine("READY"); $out.Flush()

$down = $false
$ticks = 0
while ($true) {
  $isDown = (([int][Opennib.Keys]::GetAsyncKeyState($vk)) -band 0x8000) -ne 0
  if ($isDown -ne $down) {
    $down = $isDown
    $out.WriteLine($(if ($down) { "DOWN" } else { "UP" })); $out.Flush()
  }
  $ticks++
  if ($ParentPid -gt 0 -and ($ticks % 80) -eq 0) {
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  }
  Start-Sleep -Milliseconds 25
}
