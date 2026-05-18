"""zdata annotation schema v1.0.0.

LanceDB tables for 3D cuboid, 2D polygon, trajectory, and temporal annotations.
Reuses Foxglove SceneUpdate primitives (cube/line/cylinder) for 3D geometry.
Annotations reference zdata frames by frame_id or time range.

Data flow:
  MCAP → Foxglove Extension (annotation overlay) → ClientPublish → bridge
  → MCAP attachment (annotation channel) → zdata ingest → these Lance tables
"""

from pathlib import Path
from typing import Optional

import pyarrow as pa

ANNOTATION_VERSION = "1.0.0"

# ── 3D Cuboid (Foxglove SceneUpdate cube primitive) ────────────────────

CUBOIDS_SCHEMA = pa.schema([
    # identity
    pa.field("annotation_id", pa.string(), nullable=False),  # UUID4
    pa.field("frame_id", pa.string(), nullable=False),        # references frames.frame_id
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mower_id", pa.string(), nullable=False),

    # 3D pose
    pa.field("x", pa.float64()), pa.field("y", pa.float64()), pa.field("z", pa.float64()),
    pa.field("roll_deg", pa.float64()), pa.field("pitch_deg", pa.float64()), pa.field("yaw_deg", pa.float64()),

    # 3D size
    pa.field("size_x", pa.float64()), pa.field("size_y", pa.float64()), pa.field("size_z", pa.float64()),

    # color (RGBA, 0-1)
    pa.field("r", pa.float32()), pa.field("g", pa.float32()),
    pa.field("b", pa.float32()), pa.field("a", pa.float32()),

    # label
    pa.field("label", pa.string(), nullable=False),     # e.g. "obstacle", "tree", "boundary"
    pa.field("confidence", pa.float32()),                # 0-1, model prediction confidence

    # metadata
    pa.field("annotator", pa.string()),                  # "human:<email>" or "model:<name>"
    pa.field("review_status", pa.string()),              # "pending" | "approved" | "rejected"
    pa.field("created_at", pa.string()),                 # ISO 8601
    pa.field("tags", pa.string()),                       # JSON array
])

# ── 2D Polygon (image-space segmentation) ──────────────────────────────

POLYGONS_SCHEMA = pa.schema([
    pa.field("annotation_id", pa.string(), nullable=False),
    pa.field("frame_id", pa.string(), nullable=False),
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mower_id", pa.string(), nullable=False),

    # polygon vertices as JSON array of [x, y] points (image coordinates)
    pa.field("vertices", pa.string(), nullable=False),    # JSON: [[x1,y1], [x2,y2], ...]

    # label
    pa.field("label", pa.string(), nullable=False),       # e.g. "grass", "obstacle", "sky"
    pa.field("confidence", pa.float32()),

    # metadata
    pa.field("annotator", pa.string()),
    pa.field("review_status", pa.string()),
    pa.field("created_at", pa.string()),
    pa.field("tags", pa.string()),
])

# ── Trajectory / Path (Foxglove SceneUpdate line primitive) ────────────

TRAJECTORIES_SCHEMA = pa.schema([
    pa.field("annotation_id", pa.string(), nullable=False),
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mower_id", pa.string(), nullable=False),

    # waypoints as JSON array of [x, y, z] points (world coordinates)
    pa.field("waypoints", pa.string(), nullable=False),   # JSON: [[x1,y1,z1], ...]

    # line style
    pa.field("thickness", pa.float32()),
    pa.field("r", pa.float32()), pa.field("g", pa.float32()),
    pa.field("b", pa.float32()), pa.field("a", pa.float32()),

    # label
    pa.field("label", pa.string(), nullable=False),       # e.g. "planned_path", "actual_path", "boundary"
    pa.field("confidence", pa.float32()),

    # metadata
    pa.field("annotator", pa.string()),
    pa.field("review_status", pa.string()),
    pa.field("created_at", pa.string()),
    pa.field("tags", pa.string()),
])

# ── Time Range (temporal annotation, no geometry) ──────────────────────

TIME_RANGES_SCHEMA = pa.schema([
    pa.field("annotation_id", pa.string(), nullable=False),
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("mower_id", pa.string(), nullable=False),

    pa.field("start_tick", pa.int32(), nullable=False),
    pa.field("end_tick", pa.int32(), nullable=False),
    pa.field("start_timestamp_ns", pa.int64()),
    pa.field("end_timestamp_ns", pa.int64()),

    # label
    pa.field("label", pa.string(), nullable=False),       # e.g. "stuck", "collision_risk", "charging"
    pa.field("severity", pa.string()),                    # "info" | "warn" | "critical"

    # metadata
    pa.field("annotator", pa.string()),
    pa.field("review_status", pa.string()),
    pa.field("created_at", pa.string()),
    pa.field("notes", pa.string()),                       # free-text description
])

# ── Annotation Run (batch metadata) ────────────────────────────────────

ANNOTATION_RUNS_SCHEMA = pa.schema([
    pa.field("run_id", pa.string(), nullable=False),      # UUID4
    pa.field("mcap_file", pa.string(), nullable=False),
    pa.field("annotator", pa.string()),
    pa.field("annotation_types", pa.string()),            # JSON: ["cuboid", "polygon", ...]
    pa.field("total_annotations", pa.int32()),
    pa.field("approved_count", pa.int32()),
    pa.field("rejected_count", pa.int32()),
    pa.field("started_at", pa.string()),                  # ISO 8601
    pa.field("completed_at", pa.string()),                # ISO 8601
    pa.field("model_version", pa.string(), nullable=True), # if AI-assisted
])

# ── All tables registry ────────────────────────────────────────────────

ANNOTATION_TABLES = {
    "cuboids": CUBOIDS_SCHEMA,
    "polygons": POLYGONS_SCHEMA,
    "trajectories": TRAJECTORIES_SCHEMA,
    "time_ranges": TIME_RANGES_SCHEMA,
    "annotation_runs": ANNOTATION_RUNS_SCHEMA,
}

# ── Public API ─────────────────────────────────────────────────────────

def create_annotation_tables(lance_dir: str | Path) -> dict[str, Path]:
    """Create all annotation LanceDB tables under lance_dir/annotations/."""
    import lancedb

    root = Path(lance_dir) / "annotations"
    root.mkdir(parents=True, exist_ok=True)

    db = lancedb.connect(str(root))
    paths: dict[str, Path] = {}

    for name, schema in ANNOTATION_TABLES.items():
        table_path = root / f"{name}.lance"
        if not table_path.exists():
            db.create_table(name, schema=schema, mode="create")
        paths[name] = table_path

    return paths
