# zdata — Open Multimodal Robotics Dataset Format

**MCAP container + Apache Iceberg catalog + LanceDB query engine.** Apache 2.0.

zdata is the storage layer of the DataZero platform. It provides a standardized directory layout, typed schemas for multimodal robotics data, and exporters for common annotation and training formats.

## Design

```
dataset_name/
├── mcap/               Original MCAP files (ROS2 standard, untouched)
├── lance/              LanceDB tables (multimodal query engine)
│   ├── frames.lance/   Per-tick aligned frames (image + odom + action)
│   ├── episodes.lance/ Episode-level metadata
│   └── annotations/    Annotation tables (cuboids, polygons, trajectories, time ranges)
├── exports/            Generated exports (created on demand)
│   ├── label_studio/   Label Studio JSON import/export
│   ├── lerobot/        LeRobot v3.0 Parquet format
│   └── sharegpt/       ShareGPT JSONL for LLM/VLM fine-tuning
└── zdata.json          Dataset manifest (version, schema ref, stats)
```

**Layer responsibilities:**
- **MCAP**: Raw recording — streaming, synchronized, timestamped. Standard ROS2 container.
- **Iceberg**: Versioned catalog — schema evolution, time travel, partition pruning.
- **LanceDB**: Random-access multimodal query — blob + scalar + vector in one columnar store.

## Quickstart

```bash
pip install zdata
```

```python
import zdata

# Create a new dataset
ds = zdata.create_zdata_dataset("my_dataset")

# Import from MCAP (requires mcap package)
# python -m zdata.convert --input data.mcap --output my_dataset

# Write frames to LanceDB
import lancedb
db = lancedb.connect("my_dataset/lance")
db.create_table("frames", schema=zdata.FRAMES_SCHEMA)

# Create annotation tables
zdata.create_annotation_tables("my_dataset/lance")
```

## Tables

### `frames` — Per-tick aligned data

| Column | Type | Description |
|--------|------|-------------|
| `frame_id` | string | PK: `{mcap_hash}:{mower_id}:{tick}` |
| `mcap_file` | string | Source MCAP file |
| `mower_id` | string | Robot identifier |
| `tick` | int32 | Frame counter |
| `timestamp_ns` | int64 | Nanosecond timestamp |
| `x, y, z` | float64 | Position (m) |
| `roll_deg, pitch_deg, yaw_deg` | float64 | Orientation (degrees) |
| `speed_ms` | float64 | Linear speed |
| `angular_z` | float64 | Angular velocity |
| `throttle, steer, brake` | float64 | Control commands |
| `deck_active` | bool | Mower deck engaged |
| `coverage_pct` | float64 | Coverage percentage |
| `image_jpg` | binary? | JPEG bytes, null if no camera |

### `episodes` — Recording session metadata

| Column | Type | Description |
|--------|------|-------------|
| `episode_id` | string | PK: hash of MCAP path + start tick |
| `mcap_file` | string | Source file path |
| `mcap_size_bytes` | int64 | File size |
| `start_tick, end_tick` | int32 | Tick range |
| `duration_s` | float64 | Duration in seconds |
| `mower_count` | int32 | Number of mowers |
| `total_frames` | int32 | Total frames |
| `town_map` | string? | CARLA map name or "real" |

### Annotation tables

Five tables for different annotation types:
- **cuboids** — 3D bounding boxes (Foxglove cube primitives)
- **polygons** — 2D image-space segmentation
- **trajectories** — Path/waypoint sequences (Foxglove line primitives)
- **time_ranges** — Temporal annotations (stuck, collision_risk, charging)
- **annotation_runs** — Batch metadata

All annotation tables include `annotator` (human or model identity), `review_status` (pending/approved/rejected), and `confidence` fields.

## Export formats

### Label Studio

```python
# Export annotations to Label Studio import format
# See converters/mcap_to_annotations.py for full pipeline
```

### LeRobot v3.0

zdata exports LeRobot-compatible Parquet files with episode-level metadata. Compatible with HuggingFace LeRobot training pipelines.

### ShareGPT JSONL

For VLM/LLM fine-tuning:
```json
{"conversations": [{"from": "human", "value": "..."}, {"from": "gpt", "value": "..."}]}
```

## JSON Schema

All table schemas are available as JSON Schema (draft 2020-12) in `schemas/`.

## License

Apache 2.0 — see [LICENSE](../LICENSE)
