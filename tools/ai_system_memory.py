"""Read-only OS memory probes, including runtimes without optional psutil."""
import ctypes
import os
from pathlib import Path
import sys


def available_memory():
    try:
        import psutil
        return int(psutil.virtual_memory().available)
    except (ImportError, OSError, AttributeError):
        pass
    try:
        if sys.platform == "win32":
            class Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_uint32), ("load", ctypes.c_uint32)] + [
                    (name, ctypes.c_uint64) for name in (
                        "totalPhys", "availPhys", "totalPage", "availPage", "totalVirtual", "availVirtual", "extended")]
            status = Status()
            status.length = ctypes.sizeof(status)
            if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                raise OSError("GlobalMemoryStatusEx failed")
            return int(status.availPhys)
        if sys.platform.startswith("linux"):
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024
        # psutil remains the preferred macOS probe. Do not substitute total
        # capacity or swap for available unified memory when it is absent.
    except (OSError, ValueError, AttributeError):
        pass
    return None


def process_memory():
    try:
        import psutil
        memory = psutil.Process().memory_info()
        return int(memory.rss), getattr(memory, "private", None)
    except (ImportError, OSError, AttributeError):
        pass
    if sys.platform == "win32":
        class Counters(ctypes.Structure):
            _fields_ = [("cb", ctypes.c_uint32), ("faults", ctypes.c_uint32)] + [
                (name, ctypes.c_size_t) for name in (
                    "peakWorkingSet", "workingSet", "peakPagedPool", "pagedPool", "peakNonPagedPool",
                    "nonPagedPool", "pagefile", "peakPagefile", "private")]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentProcess.restype = ctypes.c_void_p
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        psapi.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_uint32]
        if not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            raise OSError(ctypes.get_last_error(), "GetProcessMemoryInfo failed")
        return int(counters.workingSet), int(counters.private)
    if sys.platform.startswith("linux"):
        pages = int(Path("/proc/self/statm").read_text().split()[1])
        return pages * os.sysconf("SC_PAGE_SIZE"), None
    if sys.platform == "darwin":
        import resource
        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss), None
    raise OSError("Process memory measurement is unavailable")
