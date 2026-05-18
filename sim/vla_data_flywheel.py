#!/usr/bin/env python3
"""VLA Data Flywheel — closed-loop self-improving pipeline for lawn mower VLA.

Stages:
  ① CARLA fleet simulation (on zbox/JARVIS)
  ② MCAP recording with RGB cameras + odom
  ③ FiftyOne QC filtering
  ④ Convert to training format
  ⑤ QLoRA fine-tune on new data
  ⑥ Evaluate vs baseline
  ⑦ If improved → deploy to CARLA (better driving → better data)
  ⑧ Repeat

Usage:
  python3 vla_data_flywheel.py --mode once       # Single iteration
  python3 vla_data_flywheel.py --mode loop       # Continuous loop (every N hours)
  python3 vla_data_flywheel.py --mode status     # Check current flywheel state
"""

import argparse, json, os, sys, time, subprocess, shutil
from pathlib import Path
from datetime import datetime, timezone

FLYWHEEL_STATE = Path("/workspace/vla_flywheel_state.json")
TRAIN_SCRIPT = Path(__file__).parent / "train_vla_qlora.py"
EVAL_SCRIPT = Path(__file__).parent / "eval_vla_smolvlm2.py"
CONVERT_SCRIPT = Path(__file__).parent / "convert_v3_to_vla.py"
DATA_DIR = Path("/home/zhanjun/zero/sim/carla/vla_data_v3_smolvlm2")
MODEL_BASE = Path("/home/zhanjun/zero/models/SmolVLM2-500M-Video-Instruct")
BEST_MODEL = Path("/workspace/vla_model_best")


def load_state():
    if FLYWHEEL_STATE.exists():
        return json.loads(FLYWHEEL_STATE.read_text())
    return {"iterations": 0, "best_loss": float("inf"), "history": []}


def save_state(state):
    FLYWHEEL_STATE.parent.mkdir(parents=True, exist_ok=True)
    FLYWHEEL_STATE.write_text(json.dumps(state, indent=2, default=str))


def run(cmd, **kwargs):
    """Run command, return (returncode, stdout, stderr)."""
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, **kwargs)
    return result.returncode, result.stdout, result.stderr


def stage_status():
    """Report current flywheel status."""
    state = load_state()
    print("=" * 60)
    print("  VLA Data Flywheel Status")
    print("=" * 60)
    print(f"  Iterations: {state['iterations']}")
    print(f"  Best loss:  {state.get('best_loss', 'N/A')}")
    print(f"  Best iter:  {state.get('best_iteration', 'N/A')}")
    if state["history"]:
        last = state["history"][-1]
        print(f"  Last run:   {last.get('timestamp', 'N/A')}")
        print(f"  Last loss:  {last.get('final_loss', 'N/A')}")
        print(f"  Last eval:  {last.get('eval_summary', 'N/A')}")

    # Check if training is currently running
    rc, out, _ = run("ps aux | grep train_vla_qlora | grep -v grep")
    if rc == 0:
        print(f"\n  Training:   RUNNING")
        for line in out.strip().split("\n"):
            print(f"    {line[:120]}")
    else:
        print(f"\n  Training:   IDLE")

    # Check latest model
    for model_dir in ["/workspace/vla_model_v3", "/workspace/vla_model_full", BEST_MODEL]:
        mp = Path(model_dir)
        if mp.exists():
            size = sum(f.stat().st_size for f in mp.rglob("*") if f.is_file()) / 1e6
            print(f"  Model:      {model_dir} ({size:.1f} MB)")
            break
    else:
        print(f"  Model:      none found")


def collect_data():
    """Stage ①-③: Run CARLA fleet → record MCAP → QC filter → convert."""
    print("\n--- Stage ①-③: Data Collection & QC ---")
    # This requires CARLA running on zbox. For now, use existing v3 dataset.
    if DATA_DIR.exists():
        train_lines = sum(1 for _ in open(DATA_DIR / "train.jsonl"))
        val_lines = sum(1 for _ in open(DATA_DIR / "val.jsonl")) if (DATA_DIR / "val.jsonl").exists() else 0
        print(f"  Using existing dataset: {train_lines} train, {val_lines} val")
        return str(DATA_DIR)
    else:
        print(f"  Dataset not found: {DATA_DIR}")
        return None


def train_model(data_dir, output_dir, resume_from=None):
    """Stage ⑤: QLoRA fine-tune on dataset."""
    print(f"\n--- Stage ⑤: QLoRA Training ---")
    cmd = (f"python3 -u {TRAIN_SCRIPT} "
           f"--data_dir {data_dir} "
           f"--output_dir {output_dir} "
           f"--model_id {MODEL_BASE} "
           f"--epochs 3 --batch_size 2 --max_samples 0")
    print(f"  CMD: {cmd}")
    rc, stdout, stderr = run(cmd)
    if rc != 0:
        print(f"  Training FAILED: {stderr[-500:]}")
        return None
    # Parse final loss from output
    losses = []
    for line in stdout.split("\n"):
        if "'loss'" in line:
            try:
                losses.append(float(line.split("'loss': '")[1].split("'")[0]))
            except (ValueError, IndexError):
                pass
    final_loss = losses[-1] if losses else float("inf")
    print(f"  Training complete. Final loss: {final_loss:.4f}")
    return final_loss


def evaluate_model(adapter_path):
    """Stage ⑥: Evaluate trained model on validation set."""
    print(f"\n--- Stage ⑥: Evaluation ---")
    cmd = (f"python3 -u {EVAL_SCRIPT} "
           f"--adapter {adapter_path} "
           f"--data {DATA_DIR}")
    rc, stdout, stderr = run(cmd)
    if rc != 0:
        print(f"  Eval FAILED: {stderr[-500:]}")
        return None
    # Parse metrics
    metrics = {}
    for line in stdout.split("\n"):
        if "throttle MAE:" in line:
            metrics["throttle_mae"] = float(line.split(":")[1].strip().split()[0])
        elif "steer    MAE:" in line:
            metrics["steer_mae"] = float(line.split(":")[1].strip().split()[0])
        elif "deck     acc:" in line:
            metrics["deck_acc"] = float(line.split(":")[1].strip().replace("%", ""))
    print(f"  Metrics: {metrics}")
    return metrics


def deploy_model(adapter_path):
    """Stage ⑦: Deploy improved model as best."""
    print(f"\n--- Stage ⑦: Deploy ---")
    if BEST_MODEL.exists():
        shutil.rmtree(BEST_MODEL)
    shutil.copytree(adapter_path, BEST_MODEL)
    print(f"  Deployed to {BEST_MODEL}")
    return True


def run_once():
    """Single flywheel iteration."""
    state = load_state()
    iteration = state["iterations"] + 1
    timestamp = datetime.now(timezone.utc).isoformat()

    print(f"\n{'=' * 60}")
    print(f"  VLA Flywheel Iteration {iteration}")
    print(f"  Started: {timestamp}")
    print(f"{'=' * 60}")

    # ①-③ Collect data
    data_dir = collect_data()
    if not data_dir:
        print("  ABORT: no data available")
        return

    # ⑤ Train
    output_dir = f"/workspace/vla_flywheel_iter{iteration}"
    loss = train_model(data_dir, output_dir)
    if loss is None:
        return

    # ⑥ Evaluate
    metrics = evaluate_model(output_dir)
    evals = ""
    if metrics:
        evals = f"throttle_mae={metrics.get('throttle_mae','?')} steer_mae={metrics.get('steer_mae','?')} deck_acc={metrics.get('deck_acc','?')}%"

    # Record
    entry = {"iteration": iteration, "timestamp": timestamp,
             "final_loss": loss, "eval": metrics or {}, "output_dir": output_dir}
    state["history"].append(entry)

    # ⑦ Deploy if better
    improved = False
    if loss < state.get("best_loss", float("inf")):
        state["best_loss"] = loss
        state["best_iteration"] = iteration
        deploy_model(output_dir)
        improved = True
        print(f"  NEW BEST MODEL! loss={loss:.4f}")

    state["iterations"] = iteration
    save_state(state)

    print(f"\n  Iteration {iteration} complete. Improved: {improved}")
    print(f"  Best loss: {state['best_loss']:.4f} (iter {state['best_iteration']})")
    print(f"  Eval: {evals}")


def run_loop(interval_hours=24):
    """Continuous flywheel loop."""
    print(f"Starting VLA flywheel loop (every {interval_hours}h)...")
    while True:
        run_once()
        print(f"\nNext iteration in {interval_hours} hours...")
        time.sleep(interval_hours * 3600)


def main():
    p = argparse.ArgumentParser(description="VLA Data Flywheel")
    p.add_argument("--mode", choices=["once", "loop", "status"], default="status")
    p.add_argument("--interval", type=float, default=24,
                   help="Hours between flywheel iterations (loop mode)")
    args = p.parse_args()

    if args.mode == "status":
        stage_status()
    elif args.mode == "once":
        run_once()
    elif args.mode == "loop":
        run_loop(args.interval)


if __name__ == "__main__":
    main()
