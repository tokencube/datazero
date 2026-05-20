"""zdata format — Zero Data Platform's open multimodal robotics dataset format.

MCAP container + Apache Iceberg catalog + LanceDB query engine.
Apache 2.0 License.
"""

from .format import (
    ZDATA_VERSION,
    ZDATA_STRUCTURE,
    FRAMES_SCHEMA,
    EPISODES_SCHEMA,
    TOPICS_SCHEMA,
    create_zdata_dataset,
    open_zdata_dataset,
)
from .annotations import (
    ANNOTATION_VERSION,
    ANNOTATION_TABLES,
    CUBOIDS_SCHEMA,
    POLYGONS_SCHEMA,
    TRAJECTORIES_SCHEMA,
    TIME_RANGES_SCHEMA,
    ANNOTATION_RUNS_SCHEMA,
    create_annotation_tables,
)
from .torch_dataset import ZdataDataset
from .logger import (
    ZdataLogger,
    ZdataQuery,
    Points3D,
    Boxes3D,
    Scalars,
    Image,
    TextLog,
    init,
    log,
    set_frame_idx,
    flush,
    query,
)

__all__ = [
    "ZDATA_VERSION",
    "ZDATA_STRUCTURE",
    "FRAMES_SCHEMA",
    "EPISODES_SCHEMA",
    "TOPICS_SCHEMA",
    "create_zdata_dataset",
    "open_zdata_dataset",
    "ANNOTATION_VERSION",
    "ANNOTATION_TABLES",
    "CUBOIDS_SCHEMA",
    "POLYGONS_SCHEMA",
    "TRAJECTORIES_SCHEMA",
    "TIME_RANGES_SCHEMA",
    "ANNOTATION_RUNS_SCHEMA",
    "create_annotation_tables",
    "ZdataDataset",
    "ZdataLogger",
    "ZdataQuery",
    "Points3D",
    "Boxes3D",
    "Scalars",
    "Image",
    "TextLog",
    "init",
    "log",
    "set_frame_idx",
    "flush",
    "query",
]
