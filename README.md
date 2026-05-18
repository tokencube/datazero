# DataZero — Robotics Data Flywheel Platform

**zdata format** — MCAP + LanceDB + Label Studio / LeRobot / ShareGPT compatible.

Data collection, management, simulation, annotation, storage, training, and cloud control — the unified data platform for robotics.

## Components

| Layer | Tool | Status |
|-------|------|--------|
| **Format** | `zdata/` — Python package, LanceDB schema, MCAP-compatible | v1.0.0 |
| **Convert** | `converters/mcap_to_zdata.py` — MCAP → zdata | LIVE |
| **Simulation** | `sim/vla_data_flywheel.py` — CARLA VLA training data closed loop | LIVE |
| **Infra** | `infra/` — systemd services for flywheel runner | LIVE |

## Quickstart

```bash
pip install -e zdata/
python converters/mcap_to_zdata.py --input data.mcap --output dataset.zdata
```

## Format Spec

zdata = MCAP (container) + LanceDB (tables) + Label Studio / LeRobot / ShareGPT (exports).

See `zdata/format.py` for the full schema.

## License

Apache 2.0 — see [LICENSE](LICENSE)
