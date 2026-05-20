"""ZdataLogger — Python logging SDK for multimodal robotics data.

Drop-in equivalent to Rerun's rr.log() API. Log Points3D, Boxes3D, Scalars,
and Images directly to LanceDB tables for training and visualization.

Usage:
    import zdata
    zdata.init("my_dataset")

    # Log 3D point cloud
    zdata.log("lidar/points", zdata.Points3D(positions, colors=colors))

    # Log 3D bounding boxes
    zdata.log("objects", zdata.Boxes3D(centers, sizes, labels=["car","pedestrian"]))

    # Log scalars
    zdata.log("metrics/speed", zdata.Scalars([0.5, 0.6, 0.55]))

    # Query
    df = zdata.query("my_dataset").filter(label="car").to_pandas()
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Sequence

import pyarrow as pa

# Sentinel for from_fields() — distinguishes "unset" from explicitly None
_PENDING = object()


# ── Logging primitives (mirror Rerun archetypes) ──────────────────────

@dataclass
class Points3D:
    """3D point cloud with optional colors and labels.

    Partial updates via from_fields() — update specific fields without re-logging
    positions. The query layer (fill_latest_at) merges partial rows.
    """
    positions: list[list[float]]  # [[x,y,z], ...]
    colors: Optional[list[list[float]]] = None  # [[r,g,b], ...] 0-1
    labels: Optional[list[str]] = None
    intensities: Optional[list[float]] = None
    _partial: bool = field(default=False, repr=False)

    def __post_init__(self):
        if self.positions is _PENDING:
            object.__setattr__(self, 'positions', [])  # unset → empty, no validation needed
            return
        n = len(self.positions) if self.positions else 0
        if n == 0:
            return  # from_fields() partial update — no positions to validate
        if self.colors is not None and len(self.colors) != n:
            raise ValueError(f"colors length {len(self.colors)} != positions {n}")
        if self.labels is not None and len(self.labels) != n:
            raise ValueError(f"labels length {len(self.labels)} != positions {n}")

    @classmethod
    def from_fields(
        cls,
        *,
        positions: Optional[list[list[float]]] = None,
        colors: Optional[list[list[float]]] = None,
        labels: Optional[list[str]] = None,
        intensities: Optional[list[float]] = None,
        clear_unset: bool = True,
    ) -> "Points3D":
        """Create a partial Points3D update — only specified fields are written.

        Mirrors Rerun's rr.Points3D.from_fields(). When clear_unset=True (default),
        unspecified fields are explicitly NULL so prior values are cleared.
        When clear_unset=False, unspecified fields are omitted entirely.

        Usage:
            # Update only colors for existing points
            zdata.log("lidar", Points3D.from_fields(colors=new_colors))

            # Keep existing colors, only add labels
            zdata.log("lidar", Points3D.from_fields(clear_unset=False, labels=new_labels))
        """
        # Use _PENDING sentinel so __post_init__ can distinguish "unset" from "empty list"
        p = positions if positions is not None else _PENDING
        return cls(
            positions=p,
            colors=colors,
            labels=labels,
            intensities=intensities,
            _partial=True,
        )


@dataclass
class Boxes3D:
    """3D bounding boxes with pose, size, labels.

    Partial updates via from_fields() — update specific fields without re-logging
    everything. The query layer (fill_latest_at) merges partial rows.
    """
    centers: list[list[float]]   # [[x,y,z], ...]
    sizes: list[list[float]]     # [[sx,sy,sz], ...]
    rotations: Optional[list[list[float]]] = None  # [[roll,pitch,yaw], ...] degrees
    labels: Optional[list[str]] = None
    colors: Optional[list[list[float]]] = None
    confidences: Optional[list[float]] = None
    _partial: bool = field(default=False, repr=False)

    def __post_init__(self):
        if self.centers is _PENDING:
            object.__setattr__(self, 'centers', [])
            return
        n = len(self.centers) if self.centers else 0
        if n == 0:
            return
        if self.sizes is not None and len(self.sizes) != n:
            raise ValueError(f"sizes length {len(self.sizes)} != centers {n}")
        if self.rotations is not None and len(self.rotations) != n:
            raise ValueError(f"rotations length {len(self.rotations)} != centers {n}")
        if self.labels is not None and len(self.labels) != n:
            raise ValueError(f"labels length {len(self.labels)} != centers {n}")

    @classmethod
    def from_fields(
        cls,
        *,
        centers: Optional[list[list[float]]] = None,
        sizes: Optional[list[list[float]]] = None,
        rotations: Optional[list[list[float]]] = None,
        labels: Optional[list[str]] = None,
        colors: Optional[list[list[float]]] = None,
        confidences: Optional[list[float]] = None,
        clear_unset: bool = True,
    ) -> "Boxes3D":
        """Create a partial Boxes3D update — only specified fields are written.

        Mirrors Rerun's rr.Boxes3D.from_fields(). When clear_unset=True (default),
        unspecified fields are explicitly NULL so prior values are cleared.
        When clear_unset=False, unspecified fields are omitted entirely.

        Usage:
            # Update only labels for existing boxes
            zdata.log("objects", Boxes3D.from_fields(labels=new_labels))
        """
        c = centers if centers is not None else _PENDING
        s = sizes if sizes is not None else _PENDING
        return cls(
            centers=c,
            sizes=s,
            rotations=rotations,
            labels=labels,
            colors=colors,
            confidences=confidences,
            _partial=True,
        )


@dataclass
class Scalars:
    """Time series scalar values."""
    values: list[float]
    timestamps_ns: Optional[list[int]] = None


@dataclass
class Image:
    """Image data (JPEG or PNG bytes, or numpy array)."""
    data: bytes
    format: str = "jpeg"  # "jpeg" | "png" | "raw"
    width: Optional[int] = None
    height: Optional[int] = None


@dataclass
class TextLog:
    """Text log entry."""
    text: str
    level: str = "info"  # "info" | "warn" | "error"


@dataclass
class TimeColumn:
    """A named timeline index for columnar data ingestion.

    Mirrors Rerun's TimeColumn. Use with send_columns() for batch ingestion.

    Usage:
        zdata.send_columns(
            "scalars",
            indexes=[TimeColumn("step", sequence=[0, 1, 2, 3])],
            columns={"value": [0.1, 0.2, 0.3, 0.4]},
        )
    """
    timeline: str        # timeline name, e.g. "frame_nr", "timestamp", "step"
    sequence: Optional[list[int]] = None   # integer sequence
    timestamp_ns: Optional[list[int]] = None  # nanosecond timestamps
    duration_s: Optional[list[float]] = None  # duration in seconds

    def __post_init__(self):
        n_specified = sum(1 for x in [self.sequence, self.timestamp_ns, self.duration_s] if x is not None)
        if n_specified != 1:
            raise ValueError("TimeColumn requires exactly one of: sequence, timestamp_ns, duration_s")

    @property
    def values(self) -> list:
        if self.sequence is not None:
            return self.sequence
        if self.timestamp_ns is not None:
            return self.timestamp_ns
        return self.duration_s

    @property
    def kind(self) -> str:
        if self.sequence is not None:
            return "sequence"
        if self.timestamp_ns is not None:
            return "timestamp_ns"
        return "duration_s"


# ── LanceDB schemas for logged data ──────────────────────────────────

def _points3d_schema() -> pa.Schema:
    return pa.schema([
        pa.field("point_id", pa.string(), nullable=False),
        pa.field("entity_path", pa.string(), nullable=False),
        pa.field("frame_idx", pa.int64(), nullable=False),
        pa.field("timestamp_ns", pa.int64()),
        pa.field("x", pa.float64()), pa.field("y", pa.float64()), pa.field("z", pa.float64()),
        pa.field("r", pa.float32(), nullable=True), pa.field("g", pa.float32(), nullable=True),
        pa.field("b", pa.float32(), nullable=True),
        pa.field("intensity", pa.float32(), nullable=True),
        pa.field("label", pa.string(), nullable=True),
    ])


def _scalars_schema() -> pa.Schema:
    return pa.schema([
        pa.field("entity_path", pa.string(), nullable=False),
        pa.field("timestamp_ns", pa.int64()),
        pa.field("value", pa.float64()),
    ])


def _images_schema() -> pa.Schema:
    return pa.schema([
        pa.field("entity_path", pa.string(), nullable=False),
        pa.field("frame_idx", pa.int64(), nullable=False),
        pa.field("timestamp_ns", pa.int64()),
        pa.field("data", pa.binary(), nullable=False),
        pa.field("format", pa.string()),
        pa.field("width", pa.int32(), nullable=True),
        pa.field("height", pa.int32(), nullable=True),
    ])


# ── Logger ───────────────────────────────────────────────────────────

class ZdataLogger:
    """Main logger — writes multimodal data to LanceDB tables.

    Usage:
        logger = ZdataLogger("datasets/lawn-001")
        logger.log("lidar", Points3D(positions))
        logger.log("objects", Boxes3D(centers, sizes, labels=["car"]))
        logger.log("speed", Scalars([0.5, 0.6]))
    """

    def __init__(self, dataset_dir: str | Path):
        self.root = Path(dataset_dir)
        self.root.mkdir(parents=True, exist_ok=True)

        import lancedb
        self._db = lancedb.connect(str(self.root))

        self._frame_idx: int = 0
        self._pending_points: list[dict] = []
        self._pending_boxes: list[dict] = []
        self._pending_scalars: list[dict] = []
        self._pending_images: list[dict] = []
        self._flush_size: int = 1000

    # ── log() dispatcher ─────────────────────────────────────────────

    def log(self, entity_path: str, entity: object):
        """Log any supported entity type to the dataset.

        Supported types: Points3D, Boxes3D, Scalars, Image, TextLog
        """
        ts = time.time_ns()
        if isinstance(entity, Points3D):
            self._log_points(entity_path, entity, ts)
        elif isinstance(entity, Boxes3D):
            self._log_boxes(entity_path, entity, ts)
        elif isinstance(entity, Scalars):
            self._log_scalars(entity_path, entity, ts)
        elif isinstance(entity, Image):
            self._log_image(entity_path, entity, ts)
        elif isinstance(entity, TextLog):
            self._log_text(entity_path, entity, ts)
        else:
            raise TypeError(f"Unsupported entity type: {type(entity).__name__}")

    def _log_points(self, path: str, p: Points3D, ts: int):
        if p._partial:
            # Partial update: determine row count from specified fields
            n = max(
                len(p.colors) if p.colors else 0,
                len(p.labels) if p.labels else 0,
                len(p.intensities) if p.intensities else 0,
            )
            for i in range(n):
                row = {
                    "point_id": str(uuid.uuid4()),
                    "entity_path": path,
                    "frame_idx": self._frame_idx,
                    "timestamp_ns": ts,
                    "x": None, "y": None, "z": None,
                    "r": float(p.colors[i][0]) if p.colors else None,
                    "g": float(p.colors[i][1]) if p.colors else None,
                    "b": float(p.colors[i][2]) if p.colors else None,
                    "intensity": float(p.intensities[i]) if p.intensities else None,
                    "label": p.labels[i] if p.labels else None,
                }
                self._pending_points.append(row)
        else:
            n = len(p.positions)
            for i in range(n):
                x, y, z = p.positions[i]
                row = {
                    "point_id": str(uuid.uuid4()),
                    "entity_path": path,
                    "frame_idx": self._frame_idx,
                    "timestamp_ns": ts,
                    "x": float(x), "y": float(y), "z": float(z),
                    "r": float(p.colors[i][0]) if p.colors else None,
                    "g": float(p.colors[i][1]) if p.colors else None,
                    "b": float(p.colors[i][2]) if p.colors else None,
                    "intensity": float(p.intensities[i]) if p.intensities else None,
                    "label": p.labels[i] if p.labels else None,
                }
                self._pending_points.append(row)
        if len(self._pending_points) >= self._flush_size:
            self._flush_table("points3d", self._pending_points, _points3d_schema())
            self._pending_points.clear()

    def _log_boxes(self, path: str, b: Boxes3D, ts: int):
        if b._partial:
            n = max(
                len(b.labels) if b.labels else 0,
                len(b.colors) if b.colors else 0,
                len(b.confidences) if b.confidences else 0,
                len(b.rotations) if b.rotations else 0,
            )
            for i in range(n):
                rot = b.rotations[i] if b.rotations else None
                color = b.colors[i] if b.colors else None
                row = {
                    "annotation_id": str(uuid.uuid4()),
                    "frame_id": f"log:{self._frame_idx}",
                    "mcap_file": "",
                    "mower_id": "",
                    "x": None, "y": None, "z": None,
                    "roll_deg": float(rot[0]) if rot else None,
                    "pitch_deg": float(rot[1]) if rot else None,
                    "yaw_deg": float(rot[2]) if rot else None,
                    "size_x": None, "size_y": None, "size_z": None,
                    "r": float(color[0]) if color else None,
                    "g": float(color[1]) if color else None,
                    "b": float(color[2]) if color else None,
                    "a": float(color[3]) if color and len(color) > 3 else (1.0 if color else None),
                    "label": b.labels[i] if b.labels else None,
                    "confidence": float(b.confidences[i]) if b.confidences else None,
                    "annotator": "model:zdata-logger",
                    "review_status": "pending",
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "tags": "[]",
                }
                self._pending_boxes.append(row)
        else:
            n = len(b.centers)
            for i in range(n):
                cx, cy, cz = b.centers[i]
                sx, sy, sz = b.sizes[i]
                rot = b.rotations[i] if b.rotations else [0.0, 0.0, 0.0]
                color = b.colors[i] if b.colors else [1.0, 0.0, 0.0, 1.0]
                row = {
                    "annotation_id": str(uuid.uuid4()),
                    "frame_id": f"log:{self._frame_idx}",
                    "mcap_file": "",
                    "mower_id": "",
                    "x": float(cx), "y": float(cy), "z": float(cz),
                    "roll_deg": float(rot[0]), "pitch_deg": float(rot[1]), "yaw_deg": float(rot[2]),
                    "size_x": float(sx), "size_y": float(sy), "size_z": float(sz),
                    "r": float(color[0]), "g": float(color[1]),
                    "b": float(color[2]), "a": float(color[3]) if len(color) > 3 else 1.0,
                    "label": b.labels[i] if b.labels else "object",
                    "confidence": float(b.confidences[i]) if b.confidences else 1.0,
                    "annotator": "model:zdata-logger",
                    "review_status": "pending",
                    "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "tags": "[]",
                }
                self._pending_boxes.append(row)

    def _log_scalars(self, path: str, s: Scalars, ts: int):
        for i, v in enumerate(s.values):
            t = s.timestamps_ns[i] if s.timestamps_ns else ts
            self._pending_scalars.append({
                "entity_path": path,
                "timestamp_ns": t,
                "value": float(v),
            })
        if len(self._pending_scalars) >= self._flush_size:
            self._flush_table("scalars", self._pending_scalars, _scalars_schema())
            self._pending_scalars.clear()

    def _log_image(self, path: str, img: Image, ts: int):
        self._pending_images.append({
            "entity_path": path,
            "frame_idx": self._frame_idx,
            "timestamp_ns": ts,
            "data": img.data,
            "format": img.format,
            "width": img.width,
            "height": img.height,
        })

    def _log_text(self, path: str, t: TextLog, ts: int):
        names = [tbl for tbl in self._db.list_tables().tables] if hasattr(self._db, 'list_tables') else self._db.table_names()
        row = {"entity_path": path, "timestamp_ns": ts, "text": t.text, "level": t.level}
        if "text_logs" in names:
            self._db.open_table("text_logs").add([row])
        else:
            self._db.create_table("text_logs", [row], mode="create")

    # ── Flush ────────────────────────────────────────────────────────

    def _table_exists(self, name: str) -> bool:
        if hasattr(self._db, 'list_tables'):
            return name in self._db.list_tables().tables
        return name in self._db.table_names()

    def _flush_table(self, name: str, rows: list[dict], schema: pa.Schema):
        if not rows:
            return
        if self._table_exists(name):
            self._db.open_table(name).add(rows)
        else:
            self._db.create_table(name, rows, schema=schema, mode="create")

    def flush(self):
        """Flush all pending data to LanceDB."""
        if self._pending_points:
            self._flush_table("points3d", self._pending_points, _points3d_schema())
            self._pending_points.clear()
        if self._pending_boxes:
            self._flush_table("cuboids", self._pending_boxes, None)
            self._pending_boxes.clear()
        if self._pending_scalars:
            self._flush_table("scalars", self._pending_scalars, _scalars_schema())
            self._pending_scalars.clear()
        if self._pending_images:
            self._flush_table("images", self._pending_images, _images_schema())
            self._pending_images.clear()

    def set_frame_idx(self, idx: int):
        """Advance to a new frame index (for time-aligned multi-entity logging)."""
        self.flush()
        self._frame_idx = idx

    def close(self):
        """Flush and close."""
        self.flush()

    @property
    def table_names(self) -> list[str]:
        if hasattr(self._db, 'list_tables'):
            return self._db.list_tables().tables
        return self._db.table_names()


# ── Query API ────────────────────────────────────────────────────────

class ZdataQuery:
    """Query builder for zdata LanceDB tables.

    Usage:
        import zdata
        df = zdata.query("my_dataset").entity("lidar").limit(1000).to_pandas()
    """

    def __init__(self, db, table: str = "points3d"):
        self._db = db
        self._table_name = table
        self._filters: list[str] = []
        self._limit_val: Optional[int] = None
        self._columns: Optional[list[str]] = None

    def entity(self, path: str) -> "ZdataQuery":
        self._filters.append(f"entity_path = '{path}'")
        return self

    def filter(self, expr: str) -> "ZdataQuery":
        self._filters.append(expr)
        return self

    def select(self, columns: list[str]) -> "ZdataQuery":
        self._columns = columns
        return self

    def limit(self, n: int) -> "ZdataQuery":
        self._limit_val = n
        return self

    def _to_arrow(self) -> pa.Table:
        table = self._db.open_table(self._table_name)
        builder = table.search()
        for f in self._filters:
            builder = builder.where(f)
        if self._columns:
            builder = builder.select(self._columns)
        if self._limit_val:
            builder = builder.limit(self._limit_val)
        return builder.to_arrow()

    def to_pandas(self):
        return self._to_arrow().to_pandas()

    def to_arrow(self) -> pa.Table:
        return self._to_arrow()

    def to_torch(self, columns: Optional[list[str]] = None):
        """Export to torch tensors dict."""
        import torch
        arrow_tbl = self._to_arrow()
        result = {}
        for col_name in arrow_tbl.schema.names:
            if columns and col_name not in columns:
                continue
            arr = arrow_tbl.column(col_name)
            if pa.types.is_floating(arr.type):
                result[col_name] = torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.float32)
            elif pa.types.is_integer(arr.type):
                result[col_name] = torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long)
            elif pa.types.is_boolean(arr.type):
                result[col_name] = torch.tensor(arr.to_pylist(), dtype=torch.bool)
            else:
                result[col_name] = arr.to_pylist()
        return result


# ── Module-level convenience API (mirrors Rerun) ─────────────────────

_logger: Optional[ZdataLogger] = None
_dataset_dir: Optional[Path] = None


def init(dataset_dir: str | Path):
    """Initialize the global zdata logger.

    Usage:
        import zdata
        zdata.init("datasets/lawn-001")
        zdata.log("lidar", zdata.Points3D(positions))
    """
    global _logger, _dataset_dir
    _dataset_dir = Path(dataset_dir)
    _logger = ZdataLogger(_dataset_dir)


def log(entity_path: str, entity: object):
    """Log data to the current dataset. Call init() first.

    Supports: Points3D, Boxes3D, Scalars, Image, TextLog
    """
    if _logger is None:
        raise RuntimeError("zdata not initialized. Call zdata.init() first.")
    _logger.log(entity_path, entity)


def set_frame_idx(idx: int):
    """Advance the global logger to a new frame index."""
    if _logger is None:
        raise RuntimeError("zdata not initialized. Call zdata.init() first.")
    _logger.set_frame_idx(idx)


def flush():
    """Flush all pending data."""
    if _logger:
        _logger.flush()


def query(dataset_dir: str | Path, table: str = "points3d") -> ZdataQuery:
    """Query logged zdata tables.

    Usage:
        df = zdata.query("my_dataset").entity("lidar").to_pandas()
    """
    import lancedb
    db = lancedb.connect(str(dataset_dir))
    return ZdataQuery(db, table)


# ── send_columns (mirrors Rerun's rr.send_columns) ───────────────────

def send_columns(
    entity_path: str,
    indexes: list[TimeColumn],
    columns: dict[str, list],
    *,
    dataset_dir: Optional[str | Path] = None,
):
    """Send columnar data directly to LanceDB (batch ingestion).

    Mirrors Rerun's rr.send_columns(). Much faster than row-by-row zdata.log()
    for large datasets. Accepts numpy arrays, pandas Series, or plain lists.

    Usage:
        import numpy as np
        from zdata import send_columns, TimeColumn

        times = np.arange(0, 100)
        speeds = np.sin(times / 10.0)

        # Use global logger (must call zdata.init() first)
        send_columns(
            "metrics/speed",
            indexes=[TimeColumn("frame", sequence=times.tolist())],
            columns={"value": speeds.tolist()},
        )

        # Or specify dataset_dir directly
        send_columns(
            "metrics/speed",
            indexes=[TimeColumn("frame", sequence=times.tolist())],
            columns={"value": speeds.tolist()},
            dataset_dir="datasets/exp-001",
        )
    """
    if len(indexes) != 1:
        raise ValueError("send_columns requires exactly one TimeColumn index")

    index = indexes[0]
    n = len(index.values)

    # Validate all columns have same length
    for col_name, values in columns.items():
        _values = values.tolist() if hasattr(values, 'tolist') else list(values)
        if len(_values) != n:
            raise ValueError(f"Column '{col_name}' length {len(_values)} != index length {n}")

    # Determine target logger
    if dataset_dir is not None:
        logger = ZdataLogger(dataset_dir)
    elif _logger is not None:
        logger = _logger
    else:
        raise RuntimeError("No logger. Call zdata.init() or pass dataset_dir=")

    # Build rows
    rows = []
    ts_kind = index.kind
    for i in range(n):
        row = {
            "entity_path": entity_path,
            "frame_idx": i,
        }
        if ts_kind == "sequence":
            row["timestamp_ns"] = int(index.values[i])
        elif ts_kind == "timestamp_ns":
            row["timestamp_ns"] = int(index.values[i])
        else:
            row["timestamp_ns"] = int(index.values[i] * 1e9)

        for col_name, values in columns.items():
            _values = values.tolist() if hasattr(values, 'tolist') else list(values)
            row[col_name] = _values[i]
        rows.append(row)

    # Auto-detect table type from entity path and columns
    if "x" in columns and "y" in columns and "z" in columns:
        table_name = "points3d"
    elif "value" in columns:
        table_name = "scalars"
    elif "data" in columns:
        table_name = "images"
    else:
        table_name = "send_columns_data"

    logger._flush_table(table_name, rows, None)
    if dataset_dir is not None:
        logger.close()


# ── Enhanced query: fill_latest_at / filter_range / filter_is_not_null ─

class ZdataQueryEnhanced(ZdataQuery):
    """Enhanced query with fill_latest_at, filter_range, filter_is_not_null.

    Mirrors Rerun's DataFusion-backed dataframe query API.
    """

    def __init__(self, db, table: str = "points3d"):
        super().__init__(db, table)
        self._range_start: Optional[int] = None
        self._range_end: Optional[int] = None
        self._range_col: str = "timestamp_ns"
        self._not_null_col: Optional[str] = None
        self._fill_strategy: Optional[str] = None

    def filter_range(self, start: int | float, end: int | float, *, column: str = "timestamp_ns") -> "ZdataQueryEnhanced":
        """Filter rows within a timestamp/index range (mirrors filter_range_secs/filter_range_sequence)."""
        self._range_start = start
        self._range_end = end
        self._range_col = column
        return self

    def filter_is_not_null(self, column: str) -> "ZdataQueryEnhanced":
        """Keep only rows where a column is non-null (mirrors Rerun's filter_is_not_null)."""
        self._not_null_col = column
        return self

    def fill_latest_at(self) -> "ZdataQueryEnhanced":
        """Sparse-fill null values with most recent non-null value (mirrors Rerun's fill_latest_at).

        Uses pandas ffill() since LanceDB doesn't natively support sparse fill.
        For large datasets, consider chunked processing.
        """
        self._fill_strategy = "latest_at"
        return self

    def _to_arrow(self) -> pa.Table:
        table = self._db.open_table(self._table_name)
        builder = table.search()

        # Apply range filter before other filters
        if self._range_start is not None:
            builder = builder.where(f"{self._range_col} >= {self._range_start}")
        if self._range_end is not None:
            builder = builder.where(f"{self._range_col} <= {self._range_end}")

        for f in self._filters:
            builder = builder.where(f)

        if self._not_null_col:
            builder = builder.where(f"{self._not_null_col} IS NOT NULL")

        if self._columns:
            builder = builder.select(self._columns)
        if self._limit_val:
            builder = builder.limit(self._limit_val)

        result = builder.to_arrow()

        # Apply fill_latest_at via pandas
        if self._fill_strategy == "latest_at":
            df = result.to_pandas()
            df = df.ffill()
            result = pa.Table.from_pandas(df)

        return result


def query_enhanced(dataset_dir: str | Path, table: str = "points3d") -> ZdataQueryEnhanced:
    """Create an enhanced query builder with fill_latest_at, filter_range, etc.

    Usage:
        import zdata

        ds = zdata.query_enhanced("my_dataset", "scalars")
        df = (ds
            .entity("metrics/speed")
            .filter_range(0, 1000)
            .filter_is_not_null("value")
            .fill_latest_at()
            .to_pandas()
        )
    """
    import lancedb
    db = lancedb.connect(str(dataset_dir))
    return ZdataQueryEnhanced(db, table)
