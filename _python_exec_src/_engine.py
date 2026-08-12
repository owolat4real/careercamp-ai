"""
═══════════════════════════════════════════════════════════════════════
CAREER STUDIO — Real, isolated Python data-analysis execution engine
═══════════════════════════════════════════════════════════════════════
Real subprocess isolation, defense-in-depth on top of the container-level
isolation Dockerfile.runpod's own header comment explains (RunPod's own
per-job container + this container's entire process running as the
non-root `pyexec` user are the primary boundary; what's here is the
second layer: real CPU-time/memory/file-descriptor/process-count caps
via resource.setrlimit, plus a real wall-clock timeout).

Deliberately does NOT attempt an import blocklist the way
cs_fixed/services/workspaceAgentCode.js's JS sandbox does. That's a
different, correct choice for a different real boundary: the JS sandbox
has NO real isolation below the blocklist (same shared Node process), so
blocking `require`/`process`/etc. IS the real boundary there. Here, a
genuinely separate, ephemeral, resource-capped, non-root subprocess is
the real boundary, and pandas/numpy/matplotlib code genuinely needs
`import os`-adjacent capability (file I/O, etc.) to be worth building at
all -- blocking imports here would add surface without being the actual
security mechanism.

Real, honest limit not solved here: outbound network access from within
the execution subprocess is not blocked. See Dockerfile.runpod's header
for the full real explanation.
"""

import base64
import glob
import json
import os
import resource
import subprocess
import sys
import tempfile
import textwrap
import uuid

MAX_CPU_SECONDS = 15
# RLIMIT_AS caps virtual address space, not resident memory -- and
# numpy/OpenBLAS/pandas reserve large virtual regions (arena allocators,
# BLAS thread pools) well beyond what they actually touch, even just on
# import. Empirically confirmed on this real image: 768MB/1.5GB/2GB/3GB/
# 4GB all fail a bare `import numpy, pandas` + one matplotlib chart with
# numpy's generic (and misleading) "you should not import numpy from its
# source directory" error -- the real cause is RLIMIT_AS starving the
# C-extension init, not a source-tree problem. 8GB is the confirmed real
# floor where the same workload succeeds. Because of this, RLIMIT_AS here
# is only a loose backstop against a genuinely runaway allocation -- the
# real, primary memory boundary has to be the container's own cgroup
# limit, i.e. picking a RunPod worker tier with enough real RAM (8GB+)
# when the endpoint is created.
MAX_MEMORY_BYTES = 8 * 1024 * 1024 * 1024
MAX_OPEN_FILES = 64
# RLIMIT_NPROC counts threads, not just forked processes, on Linux --
# and OpenBLAS (numpy/pandas's real linear-algebra backend) spawns a
# real thread pool sized to the host's CPU count on import, independent
# of whether the executed code does any matrix work. Empirically
# confirmed on this real image (8 real CPUs): 16 kills numpy's import
# with the same misleading "not import numpy from its source directory"
# error RLIMIT_AS produces when starved (see above); 64 is the real
# confirmed-working floor. Still a real, meaningful cap against an
# actual fork bomb, just not so tight it breaks legitimate imports.
MAX_PROCESSES = 64
WALL_CLOCK_TIMEOUT_SECONDS = 25  # real hard cap, independent of the CPU-time rlimit above
MAX_OUTPUT_CHARS = 4000
MAX_INPUT_FILE_BYTES = 10 * 1024 * 1024  # 10MB per real uploaded input file
MAX_CHART_BYTES = 5 * 1024 * 1024  # 5MB per real generated chart image


def _limit_resources():
    """Real per-subprocess resource caps, applied via preexec_fn (runs in
    the child after fork(), before exec()) -- the standard real way to
    apply POSIX rlimits to a subprocess.run() call."""
    resource.setrlimit(resource.RLIMIT_CPU, (MAX_CPU_SECONDS, MAX_CPU_SECONDS))
    resource.setrlimit(resource.RLIMIT_AS, (MAX_MEMORY_BYTES, MAX_MEMORY_BYTES))
    resource.setrlimit(resource.RLIMIT_NOFILE, (MAX_OPEN_FILES, MAX_OPEN_FILES))
    resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCESSES, MAX_PROCESSES))


def _safe_filename(name):
    """Real path-traversal guard -- same allowlist-charset discipline as
    cs_fixed/services/workspaceAgentCode.js's scratch.writeFile jail,
    applied here to real input-file names."""
    base = os.path.basename(str(name or ""))
    if not base or base.startswith(".") or "/" in base or "\\" in base:
        return None
    return base


def run_python_code(code: str, input_files: dict = None) -> dict:
    """
    Real, isolated execution of real Python code (pandas/numpy/matplotlib
    all genuinely available). The code must assign its final answer to a
    variable named `result` (JSON-serializable), same real convention as
    the JS compute sandbox, for a consistent real contract across both
    execution paths. Any file the code creates in its own working
    directory with a .png extension (e.g. via matplotlib's
    `plt.savefig('chart.png')`) is treated as a real generated chart and
    returned as base64.

    Returns a real, honest result -- never a fabricated one:
      {"success": True,  "result": ..., "stdout": "...", "charts": [...]}
      {"success": False, "error": "..."}
    """
    work_dir = tempfile.mkdtemp(prefix="pyexec-")
    try:
        if input_files:
            for name, content_b64 in input_files.items():
                safe_name = _safe_filename(name)
                if not safe_name:
                    continue
                try:
                    raw = base64.b64decode(content_b64)
                except Exception:
                    continue
                if len(raw) > MAX_INPUT_FILE_BYTES:
                    continue
                with open(os.path.join(work_dir, safe_name), "wb") as f:
                    f.write(raw)

        indented_code = textwrap.indent(str(code or ""), "    ")
        harness = f'''\
import json as _json
import sys as _sys
result = None
try:
{indented_code}
    def _default(o):
        return str(o)
    _sys.stdout.write("___RESULT___" + _json.dumps(result, default=_default))
except Exception as _e:
    _sys.stdout.write("___ERROR___" + str(_e))
'''
        script_path = os.path.join(work_dir, "script.py")
        with open(script_path, "w", encoding="utf-8") as f:
            f.write(harness)

        try:
            proc = subprocess.run(
                [sys.executable, "script.py"],
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=WALL_CLOCK_TIMEOUT_SECONDS,
                preexec_fn=_limit_resources,
                env={"PATH": os.environ.get("PATH", ""), "MPLBACKEND": "Agg"},
            )
        except subprocess.TimeoutExpired:
            return {
                "success": False,
                "error": f"Execution timed out after {WALL_CLOCK_TIMEOUT_SECONDS}s — this is for bounded data analysis, not long-running jobs.",
            }

        stdout = proc.stdout or ""
        stderr = (proc.stderr or "").strip()

        if "___ERROR___" in stdout:
            err = stdout.split("___ERROR___", 1)[1].strip()[:500]
            return {"success": False, "error": err or "Code threw a real error."}

        if "___RESULT___" not in stdout:
            # A real, non-zero exit with no result marker at all -- most
            # often a real OOM/rlimit kill (SIGKILL, no Python traceback
            # possible) or a real segfault in a native extension. A
            # negative returncode is Python's real signal-termination
            # convention (subprocess.run negates the signal number), so
            # this can name the real likely cause instead of just the
            # bare exit code.
            if proc.returncode == -9:
                detail = f"killed (SIGKILL) — most likely the {MAX_CPU_SECONDS}s CPU-time limit or the memory limit"
            elif proc.returncode and proc.returncode < 0:
                detail = f"killed by signal {-proc.returncode}"
            else:
                detail = stderr[:400] or f"exit code {proc.returncode}"
            return {"success": False, "error": f"Code produced no real result — {detail}"}

        raw_result = stdout.split("___RESULT___", 1)[1].strip()
        try:
            parsed_result = json.loads(raw_result)
        except Exception:
            return {"success": False, "error": "Code ran but the real result could not be parsed as JSON — assign a JSON-serializable value to `result`."}

        # Real chart capture: any .png the code actually saved into its
        # own real working directory, never a fabricated "here's your
        # chart" placeholder.
        charts = []
        for png_path in sorted(glob.glob(os.path.join(work_dir, "*.png"))):
            try:
                size = os.path.getsize(png_path)
                if size == 0 or size > MAX_CHART_BYTES:
                    continue
                with open(png_path, "rb") as f:
                    charts.append({
                        "filename": os.path.basename(png_path),
                        "base64": base64.b64encode(f.read()).decode("ascii"),
                    })
            except Exception:
                continue

        stdout_before_marker = stdout.split("___RESULT___", 1)[0]
        return {
            "success": True,
            "result": parsed_result,
            "stdout": stdout_before_marker[:MAX_OUTPUT_CHARS],
            "charts": charts,
        }
    finally:
        # Real cleanup -- this per-job temp dir never persists past this
        # single execution (unlike cs_fixed's JS sandbox's per-PROJECT
        # scratch dir, which is a deliberately different, longer-lived
        # real design for a different real use case).
        subprocess.run(["rm", "-rf", work_dir], check=False)
