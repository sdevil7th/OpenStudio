import os
import subprocess
import sys
import platform
import argparse
import signal
import atexit
import time
import urllib.request
import urllib.error

# Track background processes for cleanup
vite_process = None
cpp_process = None

VITE_DEV_URL = "http://localhost:5173"

def kill_process_tree(pid):
    """Kill a process and all its child processes (Windows: taskkill /T)"""
    if platform.system() == "Windows":
        # /T = kill child processes, /F = force
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        try:
            os.killpg(os.getpgid(pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass

def kill_orphaned_openstudio():
    """Kill any leftover OpenStudio and its child processes from previous runs"""
    if platform.system() == "Windows":
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq OpenStudio.exe", "/FO", "CSV", "/NH"],
            capture_output=True, text=True
        )
        for line in result.stdout.strip().splitlines():
            if "OpenStudio.exe" in line:
                parts = line.split(",")
                if len(parts) >= 2:
                    pid = parts[1].strip('"')
                    print(f"  Killing orphaned OpenStudio.exe (PID {pid}) and its child processes...")
                    kill_process_tree(int(pid))
                    time.sleep(0.5)
    elif platform.system() == "Linux":
        subprocess.run(["pkill", "-x", "OpenStudio"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def cleanup():
    """Kill background processes on exit (including child process trees)"""
    global vite_process, cpp_process
    if cpp_process and cpp_process.poll() is None:
        print("\nStopping C++ app (and WebView2 child processes)...")
        kill_process_tree(cpp_process.pid)
        try:
            cpp_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
    if vite_process and vite_process.poll() is None:
        print("Stopping Vite dev server...")
        kill_process_tree(vite_process.pid)
        try:
            vite_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass

# Register cleanup handler
atexit.register(cleanup)

def run_command(command, cwd=None, shell=True):
    print(f"Running: {command}")
    try:
        subprocess.check_call(command, cwd=cwd, shell=shell)
    except subprocess.CalledProcessError as e:
        print(f"Error running command: {command}")
        sys.exit(1)

def get_npm_executable():
    return "npm.cmd" if platform.system() == "Windows" else "npm"

def wait_for_http_server(url, timeout_seconds=30, poll_interval=0.5):
    """Wait until an HTTP server responds successfully."""
    deadline = time.time() + timeout_seconds
    last_error = None

    while time.time() < deadline:
        global vite_process
        if vite_process and vite_process.poll() is not None:
            print("Vite dev server exited before becoming ready.")
            return False

        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                status = getattr(response, "status", 200)
                if 200 <= status < 500:
                    print(f"Vite dev server is ready at {url}")
                    return True
        except (urllib.error.URLError, OSError) as exc:
            last_error = exc
            time.sleep(poll_interval)

    print(f"Timed out waiting for Vite dev server at {url}")
    if last_error is not None:
        print(f"Last connection error: {last_error}")
    return False

def build_frontend(mode="dev"):
    frontend_dir = os.path.join(os.getcwd(), "frontend")
    print("--- Building Frontend ---")
    
    # Check if node_modules exists
    if not os.path.exists(os.path.join(frontend_dir, "node_modules")):
        print("Installing dependencies...")
        run_command("npm install", cwd=frontend_dir)

    if mode == "prod":
        run_command("npm run build", cwd=frontend_dir)
    elif mode == "dev":
        print("Frontend dependencies ready.")

def get_cpp_exe_path(config="Debug"):
    """Return the platform-appropriate path to the built C++ executable."""
    if platform.system() == "Windows":
        return os.path.join("build", "OpenStudio_artefacts", config, "OpenStudio.exe")
    elif platform.system() == "Darwin":
        return os.path.join("build", "OpenStudio_artefacts", config,
                            "OpenStudio.app", "Contents", "MacOS", "OpenStudio")
    else:  # Linux
        return os.path.join("build", "OpenStudio_artefacts", config, "OpenStudio")


def build_backend(mode="debug"):
    print("--- Building Backend ---")
    build_dir = os.path.join(os.getcwd(), "build")
    if not os.path.exists(build_dir):
        os.makedirs(build_dir)

    config_type = "Debug" if mode == "debug" else "Release"

    # Configure CMake. On single-config generators (Linux/macOS Make/Ninja)
    # CMAKE_BUILD_TYPE must be set at configure time, not just at build time.
    cmd = f"cmake -B \"{build_dir}\""
    if platform.system() != "Windows":
        cmd += f" -DCMAKE_BUILD_TYPE={config_type}"
    if mode == "debug":
        cmd += " -DJUCE_DEBUG=ON"

    run_command(cmd)

    # Build
    run_command(f"cmake --build \"{build_dir}\" --config {config_type}")

def start_vite_server():
    """Start Vite dev server in background"""
    global vite_process
    frontend_dir = os.path.join(os.getcwd(), "frontend")
    print("\n--- Starting Vite Dev Server ---")
    vite_process = subprocess.Popen(
        [get_npm_executable(), "run", "dev"],
        cwd=frontend_dir,
        shell=False
    )
    print(f"Waiting for Vite to start on {VITE_DEV_URL}...")
    if not wait_for_http_server(VITE_DEV_URL):
        cleanup()
        print("Unable to confirm the Vite dev server is reachable, so the native app was not launched.")
        sys.exit(1)
    return vite_process

def run_cpp_app():
    """Run the C++ executable"""
    global cpp_process
    exe_path = get_cpp_exe_path("Debug")
    if not os.path.exists(exe_path):
        print(f"ERROR: Executable not found at {exe_path}")
        print("Run 'python build.py dev' first to build the app.")
        sys.exit(1)

    print(f"\n--- Launching {exe_path} ---")
    cpp_process = subprocess.Popen([exe_path])
    
    # Wait for C++ app to finish
    try:
        cpp_process.wait()
    except KeyboardInterrupt:
        print("\nShutting down...")

def main():
    parser = argparse.ArgumentParser(description="OpenStudio Builder Tool")
    parser.add_argument("mode", choices=["dev", "prod"], help="Build mode: dev or prod")
    parser.add_argument("--run", action="store_true", help="Auto-start Vite and C++ app (dev mode only)")
    args = parser.parse_args()

    if args.mode == "dev":
        build_frontend("dev")
        build_backend("debug")
        
        if args.run:
            print("\n" + "="*50)
            print("SINGLE COMMAND DEV MODE")
            print("="*50)
            # Kill any orphaned OpenStudio processes (and their WebView2 children)
            # from previous runs that weren't cleaned up properly
            print("Checking for orphaned processes...")
            kill_orphaned_openstudio()
            start_vite_server()
            run_cpp_app()
        else:
            print("\nBuild Complete. To run:")
            print("1. Manual: cd frontend && npm run dev (then run exe)")
            print("2. Auto:   python build.py dev --run")
    
    elif args.mode == "prod":
        build_frontend("prod")
        build_backend("release")
        print("\nProduction Build Complete.")
        print(f"Run: {get_cpp_exe_path('Release')}")

if __name__ == "__main__":
    main()
