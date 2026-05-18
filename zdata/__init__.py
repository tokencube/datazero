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

__all__ = [
    "ZDATA_VERSION",
    "ZDATA_STRUCTURE",
    "FRAMES_SCHEMA",
    "EPISODES_SCHEMA",
    "TOPICS_SCHEMA",
    "create_zdata_dataset",
    "open_zdata_dataset",
]
