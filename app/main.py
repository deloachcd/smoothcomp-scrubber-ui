import asyncio
import json
import os
import subprocess
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

app = FastAPI()

VIDEOS_DIR = Path(os.environ.get("VIDEOS_DIR", "/videos"))
OUTPUTS_DIR = Path(os.environ.get("OUTPUTS_DIR", "/outputs"))
CONFIG_DIR = Path(os.environ.get("CONFIG_DIR", "/config"))
SCRUBBER_BIN = os.environ.get("SCRUBBER_BIN", "get-smoothcomp-timestamps.py")
CLIPS_BIN = os.environ.get("CLIPS_BIN", "make-clips.py")

LISTS_FILE = CONFIG_DIR / "competitor_lists.json"
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".mov", ".avi", ".webm"}

# In-memory job store: job_id -> {"status": str, "log": [str]}
jobs: dict[str, dict] = {}


def load_lists() -> dict:
    if LISTS_FILE.exists():
        return json.loads(LISTS_FILE.read_text())
    return {}


def save_lists(data: dict):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    LISTS_FILE.write_text(json.dumps(data, indent=2))


def find_videos(root: Path) -> list[dict]:
    results = []
    try:
        for path in sorted(root.rglob("*")):
            if path.suffix.lower() in VIDEO_EXTENSIONS:
                results.append({
                    "path": str(path),
                    "name": path.name,
                    "relative": str(path.relative_to(root)),
                })
    except PermissionError:
        pass
    return results


# ---------------------------------------------------------------------------
# Static + HTML
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    return (Path(__file__).parent / "templates" / "index.html").read_text()


# ---------------------------------------------------------------------------
# Videos
# ---------------------------------------------------------------------------

@app.get("/api/videos")
async def list_videos():
    return find_videos(VIDEOS_DIR)


# ---------------------------------------------------------------------------
# Competitor lists
# ---------------------------------------------------------------------------

class CompetitorList(BaseModel):
    name: str
    competitors: list[str]


@app.get("/api/lists")
async def get_lists():
    return load_lists()


@app.post("/api/lists")
async def save_list(body: CompetitorList):
    data = load_lists()
    data[body.name] = body.competitors
    save_lists(data)
    return {"ok": True}


@app.delete("/api/lists/{name}")
async def delete_list(name: str):
    data = load_lists()
    if name not in data:
        raise HTTPException(status_code=404, detail="List not found")
    del data[name]
    save_lists(data)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------

class ScanRequest(BaseModel):
    videos: list[str]
    list_name: str
    interval_seconds: float = 5
    gap_tolerance: int = 3
    results_file: str = "results.csv"


class ClipsRequest(BaseModel):
    results_file: str = "results.csv"
    clip_padding: float = 10
    clips_dir: str = "clips"


async def _stream_process(job_id: str, cmd: list[str]):
    jobs[job_id]["status"] = "running"
    jobs[job_id]["log"] = []
    env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
    )
    async for raw in proc.stdout:
        line = raw.decode(errors="replace").rstrip()
        jobs[job_id]["log"].append(line)
    await proc.wait()
    jobs[job_id]["status"] = "done" if proc.returncode == 0 else "error"
    jobs[job_id]["returncode"] = proc.returncode


@app.post("/api/scan")
async def start_scan(body: ScanRequest):
    lists = load_lists()
    if body.list_name not in lists:
        raise HTTPException(status_code=404, detail="Competitor list not found")

    competitors = [c.strip() for c in lists[body.list_name] if c.strip()]
    if not competitors:
        raise HTTPException(status_code=400, detail="Competitor list is empty")

    # Write competitors to a temp file inside outputs
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    comp_file = OUTPUTS_DIR / f".competitors_{uuid.uuid4().hex}.txt"
    comp_file.write_text("\n".join(competitors))

    results_path = OUTPUTS_DIR / body.results_file

    cmd = [
        "pipenv", "run", SCRUBBER_BIN,
        "-I", *body.videos,
        "-f", str(comp_file),
        "-o", str(results_path),
        "-s", str(body.interval_seconds),
        "-g", str(body.gap_tolerance),
    ]

    job_id = uuid.uuid4().hex
    jobs[job_id] = {"status": "pending", "log": [], "type": "scan", "comp_file": str(comp_file)}
    asyncio.create_task(_stream_process(job_id, cmd))
    return {"job_id": job_id}


@app.post("/api/clips")
async def start_clips(body: ClipsRequest):
    results_path = OUTPUTS_DIR / body.results_file
    if not results_path.exists():
        raise HTTPException(status_code=404, detail="Results file not found")

    clips_path = OUTPUTS_DIR / body.clips_dir
    clips_path.mkdir(parents=True, exist_ok=True)

    cmd = [
        "pipenv", "run", CLIPS_BIN,
        "-t", str(results_path),
        "-o", str(clips_path),
        "-p", str(body.clip_padding),
    ]

    job_id = uuid.uuid4().hex
    jobs[job_id] = {"status": "pending", "log": [], "type": "clips"}
    asyncio.create_task(_stream_process(job_id, cmd))
    return {"job_id": job_id}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")

    async def event_generator():
        sent = 0
        while True:
            job = jobs[job_id]
            log = job["log"]
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            if job["status"] in ("done", "error"):
                yield f"data: {json.dumps({'status': job['status']})}\n\n"
                break
            await asyncio.sleep(0.2)
        # clean up temp competitors file if present
        if "comp_file" in job:
            try:
                Path(job["comp_file"]).unlink(missing_ok=True)
            except Exception:
                pass

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

@app.get("/api/results")
async def list_results():
    if not OUTPUTS_DIR.exists():
        return []
    return [f.name for f in sorted(OUTPUTS_DIR.glob("*.csv"))]


@app.get("/api/results/{filename}")
async def get_results(filename: str):
    path = OUTPUTS_DIR / filename
    if not path.exists() or path.suffix != ".csv":
        raise HTTPException(status_code=404, detail="Results file not found")
    rows = []
    with open(path, "r") as f:
        for line in f:
            parts = [p.strip() for p in line.strip().split(",", 3)]
            if len(parts) < 3:
                continue
            rows.append({
                "name": parts[0],
                "start": parts[1],
                "end": parts[2],
                "video_file": parts[3] if len(parts) >= 4 else "",
            })
    return rows
