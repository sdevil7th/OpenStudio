# Own the entire child process lifetime. On Windows the process is suspended
# until it belongs to the job, so an early helper cannot escape ownership.
function Start-OwnedDesktopProcess {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$FilePath, [string[]]$ArgumentList = @())

    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        # A live session leader owns the group even after the application exits.
        # Its stdin is a lifetime lease: EOF also cleans up if this host exits.
        $python = (Get-Command python3 -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $startInfo = [Diagnostics.ProcessStartInfo]::new()
        $startInfo.FileName = $python
        $startInfo.UseShellExecute = $false
        $startInfo.RedirectStandardInput = $true
        $startInfo.RedirectStandardOutput = $true
        $startInfo.ArgumentList.Add((Join-Path $PSScriptRoot 'owned-desktop-process.py'))
        $startInfo.ArgumentList.Add('--')
        $startInfo.ArgumentList.Add($FilePath)
        foreach ($argument in $ArgumentList) { $startInfo.ArgumentList.Add($argument) }
        $child = [Diagnostics.Process]::Start($startInfo)
        $owner = [pscustomobject]@{ Child = $child; ExitRead = $null; ApplicationExitCode = $null; Disposed = $false }
        $owner | Add-Member ScriptProperty ExitCode {
            if ($null -eq $this.ApplicationExitCode) { throw 'The owned application has not exited.' }
            return $this.ApplicationExitCode
        }
        $owner | Add-Member ScriptMethod WaitForExit {
            param([int]$Milliseconds)
            if ($null -ne $this.ApplicationExitCode) { return $true }
            if ($this.Disposed) { throw 'The owned process has been disposed.' }
            if (!$this.ExitRead.Wait($Milliseconds)) { return $false }
            $line = $this.ExitRead.GetAwaiter().GetResult()
            if ([string]::IsNullOrEmpty($line)) { throw 'The process supervisor exited without reporting the application result.' }
            $message = $line | ConvertFrom-Json
            if ($message.event -ne 'exited') { throw "Unexpected process supervisor response: $line" }
            $this.ApplicationExitCode = [int]$message.exitCode
            return $true
        }
        $owner | Add-Member ScriptMethod Dispose {
            if ($this.Disposed) { return }
            $this.Disposed = $true
            try {
                $this.Child.StandardInput.Close()
                if (!$this.Child.WaitForExit(5000)) { throw 'Owned process supervisor did not finish cleanup within five seconds.' }
            } finally { $this.Child.Dispose() }
        }
        try {
            $ready = $child.StandardOutput.ReadLineAsync()
            if (!$ready.Wait(10000)) { throw 'Owned process supervisor did not start within ten seconds.' }
            $line = $ready.GetAwaiter().GetResult()
            if ([string]::IsNullOrEmpty($line)) { throw 'Owned process supervisor exited before application launch.' }
            $message = $line | ConvertFrom-Json
            if ($message.event -ne 'started') { throw "Owned application could not start: $line" }
            $owner.ExitRead = $child.StandardOutput.ReadLineAsync()
            return $owner
        } catch {
            $owner.Dispose()
            throw
        }
    }

    if (!('OpenStudio.Qualification.OwnedDesktopProcess' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace OpenStudio.Qualification
{
    public sealed class OwnedDesktopProcess : IDisposable
    {
        [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMITS {
            public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
            public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
        }
        [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
            public BASIC_LIMITS Basic; public IO_COUNTERS IO; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
        }
        [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
            public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
            public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
        }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
            public uint Size; public string Reserved, Desktop, Title;
            public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
            public ushort ShowWindow, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
        }
        [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMITS information, uint size);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING information, uint size, IntPtr returned);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
        [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

        IntPtr job;
        readonly Process child;
        public int ExitCode { get { return child.ExitCode; } }
        public bool WaitForExit(int milliseconds) { return child.WaitForExit(milliseconds); }

        // CommandLineToArgvW-compatible quoting, including quotes and trailing slashes.
        static string Quote(string value) {
            var result = new StringBuilder("\""); int slashes = 0;
            foreach (char c in value) {
                if (c == '\\') { slashes++; continue; }
                if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
                result.Append('\\', slashes); slashes = 0; result.Append(c);
            }
            result.Append('\\', slashes * 2); return result.Append('"').ToString();
        }
        public OwnedDesktopProcess(string path, string[] arguments) {
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            var limits = new EXTENDED_LIMITS(); limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
            PROCESS_INFORMATION process = new PROCESS_INFORMATION();
            try {
                if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) throw new Win32Exception();
                var command = new StringBuilder(Quote(path));
                foreach (string argument in arguments) command.Append(' ').Append(Quote(argument));
                var startup = new STARTUPINFO(); startup.Size = (uint)Marshal.SizeOf(startup);
                startup.Flags = 1; startup.ShowWindow = 0; // STARTF_USESHOWWINDOW, SW_HIDE
                if (!CreateProcess(path, command, IntPtr.Zero, IntPtr.Zero, false, 4, IntPtr.Zero, null, ref startup, out process)) throw new Win32Exception();
                if (!AssignProcessToJobObject(job, process.Process)) throw new Win32Exception();
                child = Process.GetProcessById((int)process.ProcessId);
                // Retain the process handle before resume, including very short-lived leaders.
                if (child.Handle == IntPtr.Zero) throw new InvalidOperationException("Unable to retain the owned process handle.");
                if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
            } catch {
                if (process.Process != IntPtr.Zero) { TerminateProcess(process.Process, 1); WaitForSingleObject(process.Process, 5000); }
                if (child != null) child.Dispose();
                CloseHandle(job); job = IntPtr.Zero;
                throw;
            } finally {
                if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
                if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            }
        }
        public void Dispose() {
            if (job == IntPtr.Zero) return;
            try {
                if (!TerminateJobObject(job, 1)) throw new Win32Exception();
                var timer = Stopwatch.StartNew();
                while (true) {
                    ACCOUNTING information;
                    if (!QueryInformationJobObject(job, 1, out information, (uint)Marshal.SizeOf(typeof(ACCOUNTING)), IntPtr.Zero)) throw new Win32Exception();
                    if (information.ActiveProcesses == 0) break;
                    if (timer.ElapsedMilliseconds >= 5000) throw new TimeoutException("Owned process job did not empty within five seconds.");
                    Thread.Sleep(25);
                }
            } finally { CloseHandle(job); job = IntPtr.Zero; child.Dispose(); }
        }
    }
}
'@
    }
    return [OpenStudio.Qualification.OwnedDesktopProcess]::new($FilePath, $ArgumentList)
}

Export-ModuleMember -Function Start-OwnedDesktopProcess
