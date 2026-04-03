import os
import subprocess
import sys
import platform
import argparse
import signal
import atexit
import time

# Track background processes for cleanup
vite_process = None
cpp_process = None

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
    """Kill any leftover OpenStudio.exe and its WebView2 child processes from previous runs"""
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

def build_backend(mode="debug"):
    print("--- Building Backend ---")
    build_dir = os.path.join(os.getcwd(), "build")
    if not os.path.exists(build_dir):
        os.makedirs(build_dir)

    config_type = "Debug" if mode == "debug" else "Release"
    
    # Configure CMake
    cmd = f"cmake -B \"{build_dir}\" -DCMAKE_BUILD_TYPE={config_type}"
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
        ["npm", "run", "dev"],
        cwd=frontend_dir,
        shell=True
    )
    # Give Vite time to start
    print("Waiting for Vite to start...")
    time.sleep(3)
    return vite_process

def run_cpp_app():
    """Run the C++ executable"""
    global cpp_process
    exe_path = os.path.join("build", "OpenStudio_artefacts", "Debug", "OpenStudio.exe")
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
        print("Run: build/OpenStudio_artefacts/Release/OpenStudio.exe")

if __name__ == "__main__":
    main()
