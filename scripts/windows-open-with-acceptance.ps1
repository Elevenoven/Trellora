param([Parameter(Mandatory=$true)][string]$File, [Parameter(Mandatory=$true)][string]$AppName, [Parameter(Mandatory=$true)][string]$EvidencePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
$quotedFile = "'" + $File.Replace("'", "''") + "'"
$dialogScript = @'
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public class NativeOpenWith {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct Info { public string file; public string description; public uint flags; }
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern int SHOpenWithDialog(IntPtr parent,ref Info info);
}
"@
$info=New-Object NativeOpenWith+Info; $info.file=FILE_PLACEHOLDER; $info.flags=4;
$result=[NativeOpenWith]::SHOpenWithDialog([IntPtr]::Zero,[ref]$info); if($result -ne 0){exit 1}
'@
$dialogScript = $dialogScript.Replace('FILE_PLACEHOLDER', $quotedFile)
$helperPath=Join-Path ([IO.Path]::GetTempPath()) (([Guid]::NewGuid().ToString())+'.ps1')
[IO.File]::WriteAllText($helperPath,$dialogScript,(New-Object Text.UTF8Encoding($true)))
# Hide the helper console without passing SW_HIDE to the native picker.
$processInfo=New-Object Diagnostics.ProcessStartInfo
$processInfo.FileName=(Join-Path $PSHOME 'powershell.exe').Replace('\','/')
$processInfo.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$helperPath+'"'
$processInfo.UseShellExecute=$false; $processInfo.CreateNoWindow=$true
$existingPickers=@(Get-Process -Name OpenWith -ErrorAction SilentlyContinue | ForEach-Object {$_.Id})
$child=[Diagnostics.Process]::Start($processInfo)
$dialog = $null
try {
  $root=[Windows.Automation.AutomationElement]::RootElement
  $condition=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,$AppName)
  $end=(Get-Date).AddSeconds(30); $item=$null
  while((Get-Date) -lt $end -and -not $item) {
    $matches=$root.FindAll([Windows.Automation.TreeScope]::Descendants,$condition)
    foreach($candidate in $matches) {
      if(-not $candidate.Current.IsOffscreen -and $candidate.Current.ControlType -ne [Windows.Automation.ControlType]::Window) { $item=$candidate; break }
    }
    if(-not $item){Start-Sleep -Milliseconds 150}
  }
  if(-not $item){$windows=$root.FindAll([Windows.Automation.TreeScope]::Children,[Windows.Automation.Condition]::TrueCondition);$names=@($windows | ForEach-Object {$_.Current.Name});$details=@($windows | Where-Object {$_.Current.Name -match '应用|打开|app|open|choose'} | ForEach-Object {$_.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition) | Select-Object -First 120 | ForEach-Object {$_.Current.Name}});throw ('Installed acceptance application was not listed in Windows Open With; childExited='+$child.HasExited+'; windows='+($names -join ' | ')+'; controls='+($details -join ' | '))}
  $dialog=$item
  while($dialog.Current.ControlType -ne [Windows.Automation.ControlType]::Window) { $parent=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($dialog); if(-not $parent){throw 'Open With window not found'}; $dialog=$parent }
  $bounds=$dialog.Current.BoundingRectangle
  $bitmap=New-Object Drawing.Bitmap([int]$bounds.Width,[int]$bounds.Height)
  $graphics=[Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen([int]$bounds.X,[int]$bounds.Y,0,0,$bitmap.Size); $bitmap.Save($EvidencePath,[Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
  $selected=$false
  for($depth=0;$depth -lt 5 -and -not $selected;$depth++) {
    $pattern=$null
    if($item.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) { $pattern.Select(); $selected=$true }
    elseif($item.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $pattern.Invoke(); $selected=$true }
    else { $item=[Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($item) }
  }
  if(-not $selected){throw 'Open With item has no supported selection pattern'}
  Start-Sleep -Milliseconds 200
  if(-not $child.HasExited) {
    $buttons=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button)))
    $confirm=$buttons | Where-Object { $_.Current.Name -in @('确定','OK','仅一次','Just once','打开','Open') } | Select-Object -First 1
    if($confirm){$confirm.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()}
  }
  if(-not $child.WaitForExit(30000)){throw 'Windows Open With did not finish'}
  if($child.ExitCode -ne 0){throw 'Windows Open With returned a failure'}
  Write-Output 'Windows Open With selection completed'
} finally {
  if(-not $child.HasExited) {
    if($dialog) { try { $cancel=$dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,(New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty,'取消')));if($cancel){$cancel.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()} } catch {} }
    if(-not $child.WaitForExit(1000)){$child.Kill()}
  }
  $child.Dispose()
  Get-Process -Name OpenWith -ErrorAction SilentlyContinue | Where-Object {$_.Id -notin $existingPickers} | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $helperPath -Force
}
