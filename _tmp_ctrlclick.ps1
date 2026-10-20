Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte sc, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@
$h=[IntPtr]48572
[W32]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 300
[W32]::SetCursorPos(1048,368) | Out-Null
Start-Sleep -Milliseconds 200
[W32]::keybd_event(0x11,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 120
[W32]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[W32]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)
Start-Sleep -Milliseconds 120
[W32]::keybd_event(0x11,0,2,[IntPtr]::Zero)
Write-Output "done"
