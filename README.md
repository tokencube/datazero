# DataZero — Robotics Data Flywheel Platform

**Unified data collection, management, simulation, annotation, storage, training, and cloud control for robotics.** Apache 2.0.

## Components

| Layer | Tool | Status |
|-------|------|--------|
| **Format** | `zdata/` — Python package, LanceDB schema, JSON Schema, MCAP-compatible | v1.0.0 |
| **Convert** | `converters/mcap_to_zdata.py` — MCAP → zdata | LIVE |
| **Convert** | `converters/mcap_to_annotations.py` — MCAP → annotation LanceDB tables | LIVE |
| **Simulation** | `sim/vla_data_flywheel.py` — CARLA VLA training data closed loop | LIVE |
| **Infra** | `infra/` — systemd services for flywheel runner | LIVE |

## zdata format

zdata = **MCAP** (ROS2 container) + **Apache Iceberg** (versioned catalog) + **LanceDB** (multimodal query engine) + **Label Studio / LeRobot / ShareGPT** (training exports).

```
dataset/
├── mcap/          Original MCAP files (untouched)
├── lance/         LanceDB tables (frames, episodes, annotations)
├── exports/       Label Studio / LeRobot / ShareGPT
└── zdata.json     Manifest
```

See [`zdata/README.md`](zdata/README.md) for full format spec, table schemas, and JSON Schema references.

## Quickstart

```bash
# Install the zdata Python package
pip install -e zdata/

# Convert MCAP to zdata
python converters/mcap_to_zdata.py --input data.mcap --output dataset.zdata

# Extract annotations from MCAP Foxglove extension attachments
python converters/mcap_to_annotations.py --input data.mcap --output dataset/lance
```

```python
import zdata

# Create a new dataset
ds = zdata.create_zdata_dataset("my_dataset")

# Open and inspect
info = zdata.open_zdata_dataset("my_dataset")
print(info["manifest"]["stats"])

# Create annotation tables
zdata.create_annotation_tables("my_dataset/lance")
```

## License

Apache 2.0 — see [LICENSE](LICENSE)
