"""
Run the Crime Intel Suite frontend and backend together.

From the repository root:
    python run.py
"""

from __future__ import annotations

import os
import queue
import signal
import socket
import subprocess
import sys
import threading
import time
from urllib import error, request
from pathlib import Path


ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
DATABASE = BACKEND / "app" / "crime_intel.db"


def configured_data_mode() -> str:
    """Read the local backend setting without exposing secrets to the launcher."""
    env_path = BACKEND / ".env"
    if not env_path.exists():
        return "demo"
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("DATA_MODE="):
            return line.split("=", 1)[1].strip().strip('"').strip("'").lower()
    return "demo"


def python_executable() -> str:
    candidates = [
        BACKEND / "venv" / "Scripts" / "python.exe",
        ROOT / ".venv" / "Scripts" / "python.exe",
        BACKEND / "venv" / "bin" / "python",
        ROOT / ".venv" / "bin" / "python",
    ]
    for candidate in candidates:
        if candidate.exists() and is_usable_python(str(candidate)):
            return str(candidate)
    if is_usable_python(sys.executable):
        return sys.executable
    raise RuntimeError("No usable Python runtime found. Install the backend requirements and try again.")


def is_usable_python(executable: str) -> bool:
    """Check that a Python runtime can load the backend's core dependencies."""
    check = subprocess.run(
        [
            executable,
            "-c",
            "import fastapi, pandas, sqlalchemy, sklearn, xgboost, shap, networkx",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return check.returncode == 0


def npm_command() -> str:
    return "npm.cmd" if os.name == "nt" else "npm"


def stream_output(name: str, process: subprocess.Popen[str], output: queue.Queue[str]) -> None:
    assert process.stdout is not None
    for line in process.stdout:
        output.put(f"[{name}] {line.rstrip()}")


def start_process(name: str, command: list[str], cwd: Path) -> subprocess.Popen[str]:
    creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        command,
        cwd=str(cwd),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        creationflags=creationflags,
    )
    return process


def stop_processes(processes: list[subprocess.Popen[str]]) -> None:
    for process in processes:
        if process.poll() is None:
            process.send_signal(signal.CTRL_BREAK_EVENT if os.name == "nt" else signal.SIGTERM)

    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()


def drain_output(output: queue.Queue[str]) -> None:
    while True:
        try:
            print(output.get_nowait(), flush=True)
        except queue.Empty:
            return


def wait_for_url(url: str, output: queue.Queue[str], processes: list[subprocess.Popen[str]], timeout: int = 120) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain_output(output)
        if any(process.poll() is not None for process in processes):
            return False
        try:
            with request.urlopen(url, timeout=2) as response:
                if 200 <= response.status < 500:
                    return True
        except (OSError, error.URLError):
            time.sleep(1)
    return False


def wait_for_port(host: str, port: int, output: queue.Queue[str], processes: list[subprocess.Popen[str]], timeout: int = 120) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        drain_output(output)
        if any(process.poll() is not None for process in processes):
            return False
        try:
            with socket.create_connection((host, port), timeout=2):
                return True
        except OSError:
            time.sleep(1)
    return False


def main() -> int:
    py = python_executable()

    data_mode = os.environ.get("DATA_MODE", configured_data_mode()).strip().lower()
    if data_mode == "demo":
        print("[setup] Generating fresh synthetic demo data...")
        generated = subprocess.run([py, "-m", "app.demo_data"], cwd=str(BACKEND))
        if generated.returncode != 0:
            return generated.returncode
    elif data_mode != "csv":
        print("[error] DATA_MODE must be either 'demo' or 'csv'.")
        return 1

    print("[setup] Importing data/karnataka_crime.csv...")
    imported = subprocess.run([py, "-m", "app.csv_import"], cwd=str(BACKEND))
    if imported.returncode != 0:
        print("[error] Add valid Karnataka crime records to data/karnataka_crime.csv before starting.")
        return imported.returncode

    processes = [
        start_process("api", [py, "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"], BACKEND),
        start_process("web", [npm_command(), "run", "dev", "--", "--host", "127.0.0.1"], FRONTEND),
    ]

    output: queue.Queue[str] = queue.Queue()
    for name, process in zip(("api", "web"), processes):
        threading.Thread(target=stream_output, args=(name, process, output), daemon=True).start()

    print("[start] Starting API and web servers...")
    api_ready = wait_for_url("http://127.0.0.1:8000/api/health", output, processes)
    web_ready = wait_for_port("127.0.0.1", 5173, output, processes)

    if api_ready and web_ready:
        print("[ready] API: http://localhost:8000")
        print("[ready] Web: http://localhost:5173")
        print("[ready] Press Ctrl+C to stop both servers.")
    else:
        print("[error] One of the servers did not become ready. Check the logs above.")

    try:
        while True:
            drain_output(output)
            time.sleep(0.2)

            for process in processes:
                if process.poll() is not None:
                    stop_processes(processes)
                    return process.returncode or 0
    except KeyboardInterrupt:
        print("\n[stop] Shutting down frontend and backend...")
        stop_processes(processes)
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
