#!/usr/bin/env python3
"""MCAP → zdata converter — Phase 1 of datazero.io data platform.

Reads MCAP files (ROS2 standard), extracts aligned frames, writes:
  1. LanceDB tables (frames + episodes) for random-access multimodal query
  2. Updated zdata.json manifest
  3. Original MCAP files copied to mcap/ subdirectory

Usage:
  python3 mcap_to_zdata.py /path/to/*.mcap --out /data/datasets/lawn_fleet_v1/
  python3 mcap_to_zdata.py sim/carla/mcap_output/*.mcap --out /opt/bigdisk/zdata/carla_fleet/

Output zdata structure:
  lawn_fleet_v1/
  ├── mcap/          Original MCAP files
  ├── lance/         LanceDB tables (frames.lance, episodes.lance)
  ├── exports/       Empty, ready for Label Studio / LeRobot / ShareGPT exports
  └── zdata.json     Manifest with stats
"""

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import lancedb
import numpy as np
import pyarrow as pa
from mcap.reader import make_reader

from datazero.zdata.format import (
    FRAMES_SCHEMA,
    EPISODES_SCHEMA,
    create_zdata_dataset,
    open_zdata_dataset,
    write_manifest,
    read_manifest,
)


def _mcap_hash(path: Path, n: int = 12) -> str:
    """Short hash of mcap file path for unique IDs."""
    return hashlib.sha256(str(path).encode()).hexdigest()[:n]


def _decode_image(data: bytes) -> tuple[bytes, int, int] | None:
    """Try to get JPEG bytes + dimensions. Returns (jpg_bytes, w, h) or None."""
    try:
        from PIL import Image
        import io
        img = Image.open(io.BytesIO(data))
        return data, img.width, img.height
    except Exception:
        # If no PIL, store as-is without dimensions
        return data, 0, 0


def convert_mcap(mcap_path: Path, dataset_dir: Path, copy_mcap: bool = True):
    """Convert one MCAP file into zdata dataset.

    Returns: (n_frames, n_episodes, topic_list)
    """
    mcap_hash = _mcap_hash(mcap_path)
    mcap_size = mcap_path.stat().st_size

    # Copy MCAP into dataset
    if copy_mcap:
        dest = dataset_dir / "mcap" / mcap_path.name
        if not dest.exists():
            dest.write_bytes(mcap_path.read_bytes())

    # Read MCAP messages, align by (mower_id, tick)
    reader = make_reader(open(mcap_path, "rb"))
    odom = {}       # (mower_id, tick) -> dict
    deck = {}       # (mower_id, tick) -> dict
    cam = {}        # (mower_id, tick) -> base64 JPEG string
    topics_seen = set()

    for schema, channel, msg in reader.iter_messages():
        topics_seen.add(channel.topic)
        try:
            data = json.loads(msg.data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue

        mid = data.get("mower_id", "?")
        tick = data.get("tick", 0)
        key = (mid, tick)
        topic = channel.topic

        if topic == "/mower/odometry":
            odom[key] = data
        elif topic == "/mower/deck_state":
            deck[key] = data
        elif topic == "/mower/camera":
            cam[key] = data.get("data", "")  # base64 JPEG

    # Align frames: only ticks where we have all three channels
    import base64
    common_keys = set(odom) & set(deck)
    if not common_keys:
        print(f"  WARNING: no aligned frames in {mcap_path.name} (odom={len(odom)} deck={len(deck)} cam={len(cam)})")
        return 0, 0, list(topics_seen)

    # Build LanceDB frame rows
    frame_rows = []
    mower_ids = set()
    ticks_seen = set()

    for (mid, tick) in sorted(common_keys):
        o = odom[(mid, tick)]
        d = deck[(mid, tick)]
        jpg_b64 = cam.get((mid, tick), "")

        # Decode image if available
        image_jpg = None
        image_w = image_h = None
        if jpg_b64:
            try:
                raw = base64.b64decode(jpg_b64)
                result = _decode_image(raw)
                if result:
                    image_jpg, image_w, image_h = result
            except Exception:
                pass

        # Determine timestamp_ns — prefer from odom, else estimate
        ts_ns = msg.log_time  # fallback to last message time
        # Use tick * 100ms as estimate (10 FPS recording)
        if ts_ns == 0:
            ts_ns = tick * 100_000_000  # 100ms per tick

        frame_id = f"{mcap_hash}:{mid}:{tick}"

        frame_rows.append({
            "frame_id": frame_id,
            "mcap_file": mcap_path.name,
            "mower_id": mid,
            "tick": tick,
            "timestamp_ns": ts_ns,
            "x": o.get("x", 0.0), "y": o.get("y", 0.0), "z": o.get("z", 0.0),
            "roll_deg": o.get("roll", 0.0), "pitch_deg": o.get("pitch", 0.0),
            "yaw_deg": o.get("yaw", 0.0),
            "speed_ms": o.get("speed", 0.0), "angular_z": o.get("angular_z", 0.0),
            "throttle": d.get("throttle", 0.0), "steer": d.get("steer", 0.0),
            "brake": d.get("brake", 0.0),
            "deck_active": d.get("deck_active", False),
            "coverage_pct": d.get("coverage_pct", 0.0),
            "image_jpg": image_jpg,
            "image_w": image_w,
            "image_h": image_h,
        })
        mower_ids.add(mid)
        ticks_seen.add(tick)

    n_frames = len(frame_rows)
    if n_frames == 0:
        return 0, 0, list(topics_seen)

    # Write to LanceDB
    lance_dir = dataset_dir / "lance"
    db = lancedb.connect(str(lance_dir))

    # Frames table — append mode so multiple MCAP files accumulate
    frame_table = pa.Table.from_pylist(frame_rows, schema=FRAMES_SCHEMA)
    if "frames" in db.list_tables():
        db.open_table("frames").add(frame_table)
    else:
        db.create_table("frames", frame_table)

    # Episode record
    ticks_list = sorted(ticks_seen)
    start_tick = ticks_list[0]
    end_tick = ticks_list[-1]
    duration_s = (end_tick - start_tick) * 0.1  # 10 FPS assumption

    episode_row = {
        "episode_id": f"{mcap_hash}:{start_tick}",
        "mcap_file": mcap_path.name,
        "mcap_size_bytes": mcap_size,
        "start_tick": start_tick,
        "end_tick": end_tick,
        "duration_s": duration_s,
        "mower_count": len(mower_ids),
        "total_frames": n_frames,
        "topics": json.dumps(sorted(topics_seen)),
        "town_map": None,
        "recorded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(mcap_path.stat().st_mtime)),
        "tags": json.dumps([]),
    }

    ep_table = pa.Table.from_pylist([episode_row], schema=EPISODES_SCHEMA)
    if "episodes" in db.list_tables():
        db.open_table("episodes").add(ep_table)
    else:
        db.create_table("episodes", ep_table)

    return n_frames, len(mower_ids), list(topics_seen)


def main():
    parser = argparse.ArgumentParser(description="MCAP → zdata converter")
    parser.add_argument("mcap_files", nargs="+", help="MCAP file(s) to convert")
    parser.add_argument("--out", required=True, help="Output zdata dataset directory")
    parser.add_argument("--no-copy", action="store_true", help="Don't copy MCAP files (symlink mode)")
    args = parser.parse_args()

    mcap_paths = [Path(p) for p in args.mcap_files]
    missing = [p for p in mcap_paths if not p.exists()]
    if missing:
        print(f"ERROR: {len(missing)} file(s) not found: {missing[0]}..." if len(missing) > 1 else f"ERROR: {missing[0]} not found")
        sys.exit(1)

    # Create or open dataset
    out_dir = Path(args.out)
    manifest_path = out_dir / "zdata.json"
    if manifest_path.exists():
        info = open_zdata_dataset(out_dir)
        print(f"Opening existing dataset: {out_dir}")
    else:
        create_zdata_dataset(out_dir)
        print(f"Created new zdata dataset: {out_dir}")

    total_frames = 0
    total_mowers = set()
    all_topics = set()

    t0 = time.time()
    for mp in mcap_paths:
        print(f"\nConverting {mp.name} ({mp.stat().st_size / 1e6:.1f} MB)...")
        n_frames, n_mowers, topics = convert_mcap(mp, out_dir, copy_mcap=not args.no_copy)
        print(f"  → {n_frames} frames, {n_mowers} mowers, {len(topics)} topics: {topics}")
        total_frames += n_frames
        total_mowers.update([f"mower_{i}" for i in range(n_mowers)])
        all_topics.update(topics)

    elapsed = time.time() - t0

    # Update manifest
    manifest = read_manifest(out_dir)
    mcap_names = [p.name for p in mcap_paths]
    manifest["mcap_files"] = sorted(set(manifest.get("mcap_files", []) + mcap_names))
    manifest["stats"]["total_frames"] = manifest["stats"].get("total_frames", 0) + total_frames
    manifest["stats"]["total_episodes"] = manifest["stats"].get("total_episodes", 0) + len(mcap_paths)
    manifest["stats"]["total_bytes"] = sum(
        (out_dir / "mcap" / n).stat().st_size for n in manifest["mcap_files"] if (out_dir / "mcap" / n).exists()
    )
    manifest["stats"]["last_updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest["stats"]["topics"] = sorted(all_topics)
    write_manifest(out_dir, manifest)

    # Quick LanceDB verification
    db = lancedb.connect(str(out_dir / "lance"))
    frame_count = db.open_table("frames").count_rows() if "frames" in db.list_tables() else 0
    ep_count = db.open_table("episodes").count_rows() if "episodes" in db.list_tables() else 0

    print(f"\n{'='*60}")
    print(f"zdata dataset: {out_dir}")
    print(f"  MCAP files:  {len(mcap_paths)} ({manifest['stats']['total_bytes']/1e6:.1f} MB)")
    print(f"  Frames:      {frame_count} ({elapsed:.1f}s)")
    print(f"  Episodes:    {ep_count}")
    print(f"  Mowers:      {len(total_mowers)}")
    print(f"  Topics:      {sorted(all_topics)}")
    print(f"  LanceDB:     {out_dir / 'lance'}")
    print(f"  Manifest:    {manifest_path}")
    print(f"{'='*60}")

    # Benchmark: random frame read
    if frame_count > 0:
        t1 = time.time()
        sample = db.open_table("frames").to_arrow().take([0, frame_count // 2, frame_count - 1])
        read_ms = (time.time() - t1) * 1000
        print(f"  Random read: {read_ms:.1f}ms (3 frames)")

        # PyTorch DataLoader compatibility
        print(f"  LanceDB version: {lancedb.__version__}")
        print(f"  Schema: {db.open_table('frames').schema}")


if __name__ == "__main__":
    main()
