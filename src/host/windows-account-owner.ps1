param([Parameter(Mandatory=$true)][string]$Directory, [Parameter(Mandatory=$true)][int]$HostProcessId)
$ErrorActionPreference = 'Stop'
# Fixed process ownership only: no resource, privilege, network, or filesystem limits.
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class CwnAccountJob : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorking, MaxWorking; public uint ActiveLimit; public UIntPtr Affinity; public uint Priority, Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long User, Kernel, PeriodUser, PeriodKernel; public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr, string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, uint size, IntPtr length);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool FreeConsole();
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
 [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
 [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
 IntPtr job; Process root;
 public CwnAccountJob() { job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error()); var l=new ExtendedLimits(); l.Basic.Flags=0x2000; if(!SetInformationJobObject(job,9,ref l,(uint)Marshal.SizeOf(l))) { var error=Marshal.GetLastWin32Error(); Dispose(); throw new Win32Exception(error); } }
 public void Attach(int pid, DateTime receiptTime, DateTime earliest) { root=Process.GetProcessById(pid); var handle=root.Handle; var started=root.StartTime.ToUniversalTime(); if(started>receiptTime || started<earliest) throw new Exception("process identity changed"); if(!AssignProcessToJobObject(job,handle)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static int ConsoleOwner(int pid) { FreeConsole(); if(!AttachConsole((uint)pid)) throw new Win32Exception(Marshal.GetLastWin32Error()); try { uint owner; if(GetWindowThreadProcessId(GetConsoleWindow(),out owner)==0 || owner==0) throw new Win32Exception(Marshal.GetLastWin32Error()); return (int)owner; } finally { FreeConsole(); } }
 public void AttachConsoleHost(int pid, DateTime latest, DateTime earliest) { using(var p=Process.GetProcessById(pid)) { var handle=p.Handle; var started=p.StartTime.ToUniversalTime(); var expected=System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"conhost.exe"); if(started>latest || started<earliest || !String.Equals(p.MainModule.FileName,expected,StringComparison.OrdinalIgnoreCase)) throw new Exception("console identity changed"); if(!AssignProcessToJobObject(job,handle)) throw new Win32Exception(Marshal.GetLastWin32Error()); } }
 public bool RootExited { get { return root.HasExited; } }
 public void Stop() { if(!TerminateJobObject(job,143)) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public bool Empty { get { Accounting a; if(!QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error()); return a.ActiveProcesses==0; } }
 public void Dispose() { if(job!=IntPtr.Zero) { CloseHandle(job); job=IntPtr.Zero; } if(root!=null) root.Dispose(); }
}
'@
$job=$null
$stage='await-bootstrap'
$consolePid=$null
$consoleParentPid=$null
try {
  $earliest=[System.IO.Directory]::GetCreationTimeUtc($Directory).AddSeconds(-1)
  $pidFile=Join-Path $Directory 'pid'
  $stopFile=Join-Path $Directory 'stop'
  [System.IO.File]::WriteAllText((Join-Path $Directory 'owner-ready'),'owner-ready')
  $until=[DateTime]::UtcNow.AddSeconds(15)
  while (!(Test-Path -LiteralPath $pidFile)) {
    if ([DateTime]::UtcNow -ge $until) { throw 'bootstrap timeout' }
    Start-Sleep -Milliseconds 20
  }
  $childPid=0
  if (![int]::TryParse([System.IO.File]::ReadAllText($pidFile),[ref]$childPid) -or $childPid -le 0) { throw 'invalid bootstrap receipt' }
  $stage='create-job'
  $job=New-Object CwnAccountJob
  $stage='attach-root'
  $job.Attach($childPid,[System.IO.File]::GetLastWriteTimeUtc($pidFile),$earliest)
  # The ConPTY console is a sibling of the bootstrap, created by the Host.
  # Resolve it through this exact console, then validate parent and creation
  # identity before adding it; never enumerate/kill processes by image name.
  $stage='resolve-console'
  $consolePid=[CwnAccountJob]::ConsoleOwner($childPid)
  $stage='validate-console-parent'
  $console=Get-CimInstance Win32_Process -Filter "ProcessId=$consolePid"
  if ($null -ne $console) { $consoleParentPid=$console.ParentProcessId }
  if ($null -eq $console -or $console.ParentProcessId -ne $HostProcessId) { throw 'console owner mismatch' }
  $stage='attach-console'
  $job.AttachConsoleHost($consolePid,[System.IO.File]::GetLastWriteTimeUtc($pidFile),$earliest)
  $stage='await-stop'
  [System.IO.File]::WriteAllText((Join-Path $Directory 'ready'),'ready')
  while (!$job.RootExited -and !(Test-Path -LiteralPath $stopFile)) { Start-Sleep -Milliseconds 50 }
  $stage='stop-job'
  $job.Stop()
  $stage='confirm-empty'
  $until=[DateTime]::UtcNow.AddSeconds(8)
  while (!$job.Empty) {
    if ([DateTime]::UtcNow -ge $until) { throw 'empty receipt timeout' }
    Start-Sleep -Milliseconds 20
  }
  [System.IO.File]::WriteAllText((Join-Path $Directory 'closed'),'closed')
  exit 0
} catch {
  # Fixed stage and numeric metadata only; no exception text/argv/environment.
  $failure=@{ stage=$stage; hostPid=$HostProcessId; ownerPid=$PID }
  if ($null -ne $consolePid) { $failure.consolePid=$consolePid }
  if ($null -ne $consoleParentPid) { $failure.consoleParentPid=$consoleParentPid }
  $errorObject=$_.Exception
  while ($null -ne $errorObject) {
    if ($errorObject -is [System.ComponentModel.Win32Exception]) { $failure.win32Code=$errorObject.NativeErrorCode; break }
    $errorObject=$errorObject.InnerException
  }
  try { [System.IO.File]::WriteAllText((Join-Path $Directory 'failure'),($failure | ConvertTo-Json -Compress)) } catch {}
  # Fixed classification only: never emit native exception/context/environment.
  [Console]::Error.WriteLine('Windows account process ownership failed')
  exit 2
} finally { if ($null -ne $job) { $job.Dispose() } }
