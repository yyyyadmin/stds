param([string]$act)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32b {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);
}
"@
if ($act -eq "down") { [W32b]::keybd_event(0x11,0,0,[IntPtr]::Zero); Write-Output "ctrl-down" }
else { [W32b]::keybd_event(0x11,0,2,[IntPtr]::Zero); Write-Output "ctrl-up" }
