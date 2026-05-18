#!/usr/bin/env python3
"""MCAP → LanceDB annotation ingest.

Reads annotation data from MCAP files (attachments + dedicated annotation
channels) and writes to LanceDB tables defined in zdata/annotations.py.

Annotation data flow:
  Foxglove Extension → ClientPublish → bridge → MCAP channel or attachment
  → mcap_offload to cloud → this script → LanceDB

Usage:
  python3 mcap_to_annotations.py /path/to/*.mcap --out /data/datasets/lawn_fleet_v1/
"""

import argparse
import json
import sys
import time
import uuid
from pathlib import Path

import lancedb
import pyarrow as pa
from mcap.reader import make_reader

from datazero.zdata.annotations import (
    CUBOIDS_SCHEMA,
    POLYGONS_SCHEMA,
    TRAJECTORIES_SCHEMA,
    TIME_RANGES_SCHEMA,
    ANNOTATION_RUNS_SCHEMA,
    create_annotation_tables,
)
from datazero.zdata.format import read_manifest, write_manifest, open_zdata_dataset

# Annotation channel name patterns (bridge writes these from ClientPublish)
ANNOTATION_CHANNELS = {
    "/annotation/cuboid": "cuboids",
    "/annotation/polygon": "polygons",
    "/annotation/trajectory": "trajectories",
    "/annotation/time_range": "time_ranges",
}


def _parse_annotation_msg(channel: str, payload: dict, mcap_file: str) -> list[dict]:
    """Parse a single annotation message into one or more LanceDB rows."""
    rows = []
    base = {
        "mcap_file": mcap_file,
        "mower_id": payload.get("mower_id", "?"),
        "label": payload.get("label", "unknown"),
        "confidence": payload.get("confidence", 1.0),
        "annotator": payload.get("annotator", "human:unknown"),
        "review_status": payload.get("review_status", "pending"),
        "created_at": payload.get("created_at", time.strftime(
            "%Y-%m-%dT%H:%M:%SZ", time.gmtime())),
        "tags": json.dumps(payload.get("tags", [])),
    }

    match channel:
        case "/annotation/cuboid":
            for obj in payload.get("objects", [payload]):
                row = {**base}
                row["annotation_id"] = obj.get("id", str(uuid.uuid4()))
                row["frame_id"] = obj["frame_id"]
                row["x"] = obj.get("x", 0.0)
                row["y"] = obj.get("y", 0.0)
                row["z"] = obj.get("z", 0.0)
                row["roll_deg"] = obj.get("roll_deg", 0.0)
                row["pitch_deg"] = obj.get("pitch_deg", 0.0)
                row["yaw_deg"] = obj.get("yaw_deg", 0.0)
                row["size_x"] = obj.get("size_x", 1.0)
                row["size_y"] = obj.get("size_y", 1.0)
                row["size_z"] = obj.get("size_z", 1.0)
                color = obj.get("color", {})
                row["r"] = color.get("r", 1.0)
                row["g"] = color.get("g", 0.0)
                row["b"] = color.get("b", 0.0)
                row["a"] = color.get("a", 1.0)
                rows.append(row)

        case "/annotation/polygon":
            for obj in payload.get("objects", [payload]):
                row = {**base}
                row["annotation_id"] = obj.get("id", str(uuid.uuid4()))
                row["frame_id"] = obj["frame_id"]
                row["vertices"] = json.dumps(obj.get("vertices", []))
                rows.append(row)

        case "/annotation/trajectory":
            row = {**base}
            row["annotation_id"] = payload.get("id", str(uuid.uuid4()))
            row["waypoints"] = json.dumps(payload.get("waypoints", []))
            row["thickness"] = payload.get("thickness", 0.1)
            color = payload.get("color", {})
            row["r"] = color.get("r", 0.0)
            row["g"] = color.get("g", 1.0)
            row["b"] = color.get("b", 0.0)
            row["a"] = color.get("a", 1.0)
            rows.append(row)

        case "/annotation/time_range":
            row = {**base}
            row["annotation_id"] = payload.get("id", str(uuid.uuid4()))
            row["start_tick"] = payload.get("start_tick", 0)
            row["end_tick"] = payload.get("end_tick", 0)
            row["start_timestamp_ns"] = payload.get("start_timestamp_ns")
            row["end_timestamp_ns"] = payload.get("end_timestamp_ns")
            row["severity"] = payload.get("severity", "info")
            row["notes"] = payload.get("notes", "")
            rows.append(row)

    return rows


def ingest_mcap_annotations(mcap_path: Path, dataset_dir: Path) -> dict[str, int]:
    """Extract annotations from MCAP and write to LanceDB tables.

    Returns: {table_name: rows_added}
    """
    lance_dir = dataset_dir / "lance"
    create_annotation_tables(lance_dir)
    db = lancedb.connect(str(lance_dir / "annotations"))

    collected: dict[str, list[dict]] = {
        "cuboids": [],
        "polygons": [],
        "trajectories": [],
        "time_ranges": [],
    }

    with open(mcap_path, "rb") as f:
        reader = make_reader(f)

        # Scan channels for annotation messages
        for _schema, channel, msg in reader.iter_messages():
            topic = channel.topic
            if topic not in ANNOTATION_CHANNELS:
                continue
            try:
                data = json.loads(msg.data)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            table_name = ANNOTATION_CHANNELS[topic]
            rows = _parse_annotation_msg(topic, data, mcap_path.name)
            collected[table_name].extend(rows)

        # Scan MCAP attachments for annotation metadata
        for attachment in reader.get_summary().attachments or []:
            if attachment.name.startswith("annotation/"):
                try:
                    reader_data = reader.get_attachment_data(attachment)
                    if reader_data is None:
                        continue
                    data = json.loads(reader_data)
                except (json.JSONDecodeError, UnicodeDecodeError):
                    continue
                table_name = attachment.name.split("/", 1)[1]  # "annotation/cuboids" → "cuboids"
                if table_name in collected:
                    rows = _parse_annotation_msg(
                        f"/annotation/{table_name.rstrip('s')}",
                        data, mcap_path.name)
                    collected[table_name].extend(rows)

    # Write to LanceDB tables
    counts = {}
    for table_name, rows in collected.items():
        if not rows:
            counts[table_name] = 0
            continue
        table_path = f"annotations/{table_name}.lance"
        # Clean None values — LanceDB rejects None in non-nullable fields
        clean_rows = []
        for r in rows:
            clean = {}
            for k, v in r.items():
                if v is None:
                    clean[k] = ""
                else:
                    clean[k] = v
            clean_rows.append(clean)

        t = pa.Table.from_pylist(clean_rows)
        if table_name in db.table_names():
            existing = db.open_table(table_name)
            existing.add(t)
        else:
            db.create_table(table_name, t, mode="overwrite")
        counts[table_name] = len(clean_rows)

    return counts


def main():
    parser = argparse.ArgumentParser(description="MCAP → LanceDB annotation ingest")
    parser.add_argument("mcap_files", nargs="+", help="MCAP file(s) to scan for annotations")
    parser.add_argument("--out", required=True, help="zdata dataset directory")
    parser.add_argument("--run-id", help="Annotation run ID (auto-generated if omitted)")
    args = parser.parse_args()

    mcap_paths = [Path(p) for p in args.mcap_files]
    missing = [p for p in mcap_paths if not p.exists()]
    if missing:
        print(f"ERROR: {len(missing)} not found — {missing[0]}")
        sys.exit(1)

    out_dir = Path(args.out)
    manifest_path = out_dir / "zdata.json"
    if not manifest_path.exists():
        print(f"ERROR: {out_dir} is not a zdata dataset (missing zdata.json)")
        sys.exit(1)

    info = open_zdata_dataset(out_dir)
    print(f"Dataset: {out_dir}")
    print(f"  Existing frames: {info['manifest']['stats'].get('total_frames', 0)}")

    # Ingest each MCAP
    run_id = args.run_id or str(uuid.uuid4())[:8]
    total = {}
    t0 = time.time()

    for mp in mcap_paths:
        print(f"\nScanning {mp.name} ({mp.stat().st_size / 1e6:.1f} MB)...")
        counts = ingest_mcap_annotations(mp, out_dir)
        for tbl, n in counts.items():
            if n > 0:
                print(f"  {tbl}: +{n} rows")
            total[tbl] = total.get(tbl, 0) + n

    elapsed = time.time() - t0

    # Record annotation run in LanceDB
    total_anns = sum(total.values())
    if total_anns > 0:
        lance_dir = out_dir / "lance"
        db = lancedb.connect(str(lance_dir / "annotations"))
        run_row = {
            "run_id": run_id,
            "mcap_file": json.dumps([p.name for p in mcap_paths]),
            "annotator": "ingest",
            "annotation_types": json.dumps([k for k, v in total.items() if v > 0]),
            "total_annotations": total_anns,
            "approved_count": 0,
            "rejected_count": 0,
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t0)),
            "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "model_version": None,
        }
        t = pa.Table.from_pylist([run_row], schema=ANNOTATION_RUNS_SCHEMA)
        if "annotation_runs" in db.table_names():
            db.open_table("annotation_runs").add(t)
        else:
            db.create_table("annotation_runs", t, mode="overwrite")

    # Update manifest
    manifest = read_manifest(out_dir)
    ann_stats = manifest.get("annotation_stats", {})
    for tbl, n in total.items():
        ann_stats[tbl] = ann_stats.get(tbl, 0) + n
    ann_stats["last_ingest"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    ann_stats["last_run_id"] = run_id
    manifest["annotation_stats"] = ann_stats
    write_manifest(out_dir, manifest)

    print(f"\n{'='*60}")
    print(f"Annotation ingest complete ({elapsed:.1f}s)")
    for tbl, n in sorted(total.items()):
        print(f"  {tbl}: {n} annotations")
    print(f"  run_id: {run_id}")
    print(f"  total:  {total_anns}")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
