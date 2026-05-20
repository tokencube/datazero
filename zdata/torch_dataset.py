"""ZdataDataset — PyTorch IterableDataset from LanceDB zdata tables.

Drop-in equivalent to Rerun's .rrd PyTorch DataLoader.
Reads zdata/frames.lance directly into torch tensors for training.

Usage:
    from zdata.torch_dataset import ZdataDataset
    ds = ZdataDataset("datasets/lawn-001/lance", columns=["x","y","throttle","steer"])
    loader = torch.utils.data.DataLoader(ds, batch_size=32)
    for batch in loader:
        ...
"""

from __future__ import annotations

from pathlib import Path
from typing import Optional, Sequence

import pyarrow as pa


def _ensure_torch():
    global torch
    try:
        import torch
    except ImportError:
        raise ImportError("ZdataDataset requires PyTorch. Install with: pip install torch")


def _ensure_lancedb():
    global lancedb
    try:
        import lancedb
    except ImportError:
        raise ImportError("ZdataDataset requires lancedb. Install with: pip install lancedb")


_ARROW_TO_TORCH: dict[pa.DataType, callable] = {}


def _build_arrow_to_torch():
    import torch

    _ARROW_TO_TORCH.clear()
    _ARROW_TO_TORCH.update({
        pa.float32(): lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.float32),
        pa.float64(): lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.float32),
        pa.int8():    lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.int16():   lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.int32():   lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.int64():   lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.uint8():   lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.uint16():  lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.uint32():  lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.uint64():  lambda arr: torch.tensor(arr.to_numpy(zero_copy_only=False), dtype=torch.long),
        pa.bool_():   lambda arr: torch.tensor(arr.to_pylist(), dtype=torch.bool),
    })


def _arrow_col_to_torch(arr: pa.Array):
    converter = _ARROW_TO_TORCH.get(arr.type, None)
    if converter is not None:
        return converter(arr)
    if pa.types.is_binary(arr.type) or pa.types.is_large_binary(arr.type):
        return arr.to_pylist()
    if pa.types.is_string(arr.type) or pa.types.is_large_string(arr.type):
        return arr.to_pylist()
    raise TypeError(f"Unsupported Arrow type: {arr.type}")


class ZdataDataset:
    """PyTorch IterableDataset backed by zdata LanceDB frames table.

    Yields individual rows as dicts of torch tensors. Use with DataLoader
    for automatic batching, shuffling, and multi-worker loading.

    Usage:
        ds = ZdataDataset("datasets/lawn-001/lance", columns=["x","y","throttle"])
        loader = torch.utils.data.DataLoader(ds, batch_size=32, shuffle=True)
        for batch in loader:
            ...
    """

    def __init__(
        self,
        lance_dir: str | Path,
        *,
        table: str = "frames",
        columns: Optional[Sequence[str]] = None,
        filter: Optional[str] = None,
        limit: Optional[int] = None,
        batch_size: int = 256,
    ):
        _ensure_torch()
        _ensure_lancedb()
        _build_arrow_to_torch()

        import torch

        self.lance_dir = Path(lance_dir)
        self.table_name = table
        self.columns = list(columns) if columns else None
        self.filter = filter
        self.limit = limit
        self.batch_size = batch_size

        import lancedb

        self._db = lancedb.connect(str(self.lance_dir))
        self._table = self._db.open_table(self.table_name)
        self._torch = torch

    def __iter__(self):
        query = self._table.search()
        if self.filter:
            query = query.where(self.filter)
        if self.columns:
            query = query.select(self.columns)
        if self.limit:
            query = query.limit(self.limit)

        scanner = query.to_arrow()
        for batch in scanner.to_batches():
            record_batch: pa.RecordBatch = batch
            row: dict[str, object] = {}
            for col_name in record_batch.schema.names:
                arr = record_batch.column(col_name)
                row[col_name] = _arrow_col_to_torch(arr)
            num_rows = len(next(iter(row.values())))
            for i in range(num_rows):
                yield {k: v[i].clone() for k, v in row.items()}

    def __getitem__(self, idx: int):
        """Single-row access by row offset. Uses LanceDB table indexing."""
        if idx < 0:
            idx = len(self) + idx
        query = self._table.search().limit(1).offset(idx)
        if self.filter:
            query = query.where(self.filter)
        if self.columns:
            query = query.select(self.columns)
        result = query.to_arrow()
        row = {}
        for col_name in result.schema.names:
            arr = result.column(col_name)
            row[col_name] = _arrow_col_to_torch(arr)[0].clone()
        return row

    def to_dataloader(self, **kwargs) -> "torch.utils.data.DataLoader":
        return self._torch.utils.data.DataLoader(self, **kwargs)

    def __len__(self) -> int:
        if self.filter or self.limit:
            query = self._table.search()
            if self.filter:
                query = query.where(self.filter)
            if self.limit:
                query = query.limit(self.limit)
            result = query.to_arrow()
            return len(result)
        return self._table.count_rows()

    @property
    def schema(self) -> pa.Schema:
        return self._table.schema

    def train_val_split(
        self, val_frac: float = 0.2, seed: int = 42
    ) -> tuple["ZdataDataset", "ZdataDataset"]:
        """Split dataset into train/val subsets via deterministic hash of frame_id.

        Reads all frame_ids, hashes them in Python (hashlib), and partitions
        by hash modulo. Reproducible across runs with the same seed.
        """
        import hashlib

        query = self._table.search().select(["frame_id"])
        if self.filter:
            query = query.where(self.filter)
        if self.limit:
            query = query.limit(self.limit)
        result = query.to_arrow()
        frame_ids = result.column("frame_id").to_pylist()

        train_ids = []
        val_ids = []
        threshold = int(val_frac * 1000)
        for fid in frame_ids:
            h = hashlib.md5(f"{seed}:{fid}".encode()).digest()
            bucket = int.from_bytes(h[:4], "little") % 1000
            if bucket < threshold:
                val_ids.append(fid)
            else:
                train_ids.append(fid)

        def _in_filter(ids: list[str]) -> str:
            quoted = ", ".join(f"'{fid}'" for fid in ids)
            base = f"frame_id IN ({quoted})"
            if self.filter:
                return f"({self.filter}) AND {base}"
            return base

        train = ZdataDataset(
            self.lance_dir,
            table=self.table_name,
            columns=self.columns,
            filter=_in_filter(train_ids),
            limit=self.limit,
            batch_size=self.batch_size,
        )
        val = ZdataDataset(
            self.lance_dir,
            table=self.table_name,
            columns=self.columns,
            filter=_in_filter(val_ids),
            limit=self.limit,
            batch_size=self.batch_size,
        )
        return train, val

    @classmethod
    def from_episode(
        cls,
        lance_dir: str | Path,
        episode_id: str,
        **kwargs,
    ) -> "ZdataDataset":
        """Create dataset filtered to a single episode."""
        from .format import EPISODES_SCHEMA

        filter = f"mcap_file = '{episode_id}'"
        if kwargs.get("filter"):
            filter = f"({kwargs.pop('filter')}) AND {filter}"
        return cls(lance_dir, filter=filter, **kwargs)

    @classmethod
    def from_mower(
        cls,
        lance_dir: str | Path,
        mower_id: str,
        **kwargs,
    ) -> "ZdataDataset":
        """Create dataset filtered to a single mower."""
        filter = f"mower_id = '{mower_id}'"
        if kwargs.get("filter"):
            filter = f"({kwargs.pop('filter')}) AND {filter}"
        return cls(lance_dir, filter=filter, **kwargs)
