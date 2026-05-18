"""zdata format specification v1.0.0.

Directory structure:
  dataset_name/
  ├── mcap/               Original MCAP files (ROS2 standard, untouched)
  │   └── *.mcap
  ├── lance/              LanceDB tables (multimodal query engine)
  │   ├── frames.lance/   Per-tick aligned frames (image ref + odom + action)
  │   └── episodes.lance/ Episode-level metadata (mcap file, duration, stats)
  ├── exports/            Generated exports (created on demand)
  │   ├── label_studio/   Label Studio JSON import/export
  │   ├── lerobot/        LeRobot v3.0 Parquet format
  │   └── sharegpt/       ShareGPT JSONL for LLM fine-tuning
  └── zdata.json          Dataset manifest (version, schema ref, stats)

Layer responsibilities:
  - MCAP: raw recording (streaming, synchronized, timestamped)
  - Iceberg: versioned catalog (schema evolution, time travel)
  - LanceDB: random-access multimodal query (blob + scalar + vector)
"""

import json
import os
import time
from pathlib import Path
from typing import Optional

import pyarrow as pa

ZDATA_VERSION = "1.0.0"

ZDATA_STRUCTURE = ["mcap", "lance", "exports", "zdata.json"]

# ── LanceDB schemas ──────────────────────────────────────────────

FRAMES_SCHEMA = pa.schema([
    # identity
    pa.field("frame_id", pa.string(), nullable=False),   # "{mcap_hash}:{mower_id}:{tick}"
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mower_id", pa.string(), nullable=False),
    pa.field("tick", pa.int32(), nullable=False),
    pa.field("timestamp_ns", pa.int64(), nullable=False),

    # pose (odometry)
    pa.field("x", pa.float64()), pa.field("y", pa.float64()), pa.field("z", pa.float64()),
    pa.field("roll_deg", pa.float64()), pa.field("pitch_deg", pa.float64()), pa.field("yaw_deg", pa.float64()),
    pa.field("speed_ms", pa.float64()), pa.field("angular_z", pa.float64()),

    # action (deck state)
    pa.field("throttle", pa.float64()), pa.field("steer", pa.float64()),
    pa.field("brake", pa.float64()), pa.field("deck_active", pa.bool_()),
    pa.field("coverage_pct", pa.float64()),

    # image
    pa.field("image_jpg", pa.binary(), nullable=True),   # raw JPEG bytes, null if no camera
    pa.field("image_w", pa.int32(), nullable=True),
    pa.field("image_h", pa.int32(), nullable=True),
])

EPISODES_SCHEMA = pa.schema([
    pa.field("episode_id", pa.string(), nullable=False),  # hash of mcap path + start tick
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mcap_size_bytes", pa.int64()),
    pa.field("start_tick", pa.int32()), pa.field("end_tick", pa.int32()),
    pa.field("duration_s", pa.float64()),
    pa.field("mower_count", pa.int32()),
    pa.field("total_frames", pa.int32()),
    pa.field("topics", pa.string()),                     # JSON array of topic strings
    pa.field("town_map", pa.string(), nullable=True),    # CARLA map name or "real"
    pa.field("recorded_at", pa.string()),                # ISO 8601
    pa.field("tags", pa.string()),                       # JSON array
])

TOPICS_SCHEMA = pa.schema([
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("topic", pa.string(), nullable=False),
    pa.field("message_count", pa.int64()),
    pa.field("schema_name", pa.string()),
    pa.field("schema_encoding", pa.string()),
])


# ── Manifest ──────────────────────────────────────────────────────

def _manifest_path(dataset_dir: Path) -> Path:
    return dataset_dir / "zdata.json"


def read_manifest(dataset_dir: Path) -> dict:
    mp = _manifest_path(dataset_dir)
    if mp.exists():
        return json.loads(mp.read_text())
    return {"version": ZDATA_VERSION, "datasets": [], "created_at": None}


def write_manifest(dataset_dir: Path, manifest: dict):
    _manifest_path(dataset_dir).write_text(json.dumps(manifest, indent=2, ensure_ascii=False))


# ── Public API ────────────────────────────────────────────────────

def create_zdata_dataset(dataset_dir: str | Path) -> Path:
    """Initialize a new zdata dataset directory with all subdirectories."""
    root = Path(dataset_dir)
    for sub in ZDATA_STRUCTURE:
        if sub == "zdata.json":
            continue
        (root / sub).mkdir(parents=True, exist_ok=True)
        (root / sub / ".gitkeep").touch(exist_ok=True)
    (root / "exports" / "label_studio").mkdir(parents=True, exist_ok=True)
    (root / "exports" / "lerobot").mkdir(parents=True, exist_ok=True)
    (root / "exports" / "sharegpt").mkdir(parents=True, exist_ok=True)

    manifest = {
        "version": ZDATA_VERSION,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "mcap_files": [],
        "lance_tables": ["frames", "episodes"],
        "stats": {"total_frames": 0, "total_episodes": 0, "total_bytes": 0},
    }
    write_manifest(root, manifest)
    return root


def open_zdata_dataset(dataset_dir: str | Path) -> dict:
    """Open an existing zdata dataset, validate structure, return info dict."""
    root = Path(dataset_dir)
    if not _manifest_path(root).exists():
        raise FileNotFoundError(f"Not a zdata dataset: {root} (missing zdata.json)")

    manifest = read_manifest(root)
    if manifest.get("version", "") != ZDATA_VERSION:
        raise ValueError(f"Dataset version mismatch: {manifest.get('version')} != {ZDATA_VERSION}")

    mcap_files = list((root / "mcap").glob("*.mcap"))
    return {
        "path": root,
        "manifest": manifest,
        "mcap_files": mcap_files,
        "lance_dir": root / "lance",
        "exports_dir": root / "exports",
    }
