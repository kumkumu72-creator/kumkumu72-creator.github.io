"""Add independently animated drawer assemblies to the WATO training GLB.

The source model already contains separate drawer fronts and handles.  This
script groups those parts, builds lightweight drawer trays from the existing
front-panel geometry, and adds one glTF animation clip per drawer.
"""

from __future__ import annotations

import copy
import json
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "WATO_EX35_simplified_2025.glb"
JSON_CHUNK = b"JSON"
BIN_CHUNK = b"BIN\x00"


def read_glb(path: Path) -> tuple[dict, bytearray]:
    data = path.read_bytes()
    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total_length != len(data):
        raise ValueError("Expected a valid glTF 2.0 binary file")

    json_length, json_type = struct.unpack_from("<I4s", data, 12)
    if json_type != JSON_CHUNK:
        raise ValueError("The first GLB chunk must contain JSON")
    json_start = 20
    gltf = json.loads(
        data[json_start : json_start + json_length]
        .decode("utf-8")
        .rstrip(" \x00")
    )

    bin_header = json_start + json_length
    bin_length, bin_type = struct.unpack_from("<I4s", data, bin_header)
    if bin_type != BIN_CHUNK:
        raise ValueError("The second GLB chunk must contain binary data")
    bin_start = bin_header + 8
    declared_length = gltf["buffers"][0]["byteLength"]
    if declared_length > bin_length:
        raise ValueError("The GLB binary buffer is shorter than declared")
    return gltf, bytearray(data[bin_start : bin_start + declared_length])


def pad4(data: bytearray, fill: int = 0) -> None:
    data.extend(bytes([fill]) * ((-len(data)) % 4))


def append_float_accessor(
    gltf: dict,
    binary: bytearray,
    values: list[float],
    accessor_type: str,
    count: int,
    *,
    minimum: list[float] | None = None,
    maximum: list[float] | None = None,
) -> int:
    pad4(binary)
    byte_offset = len(binary)
    payload = struct.pack(f"<{len(values)}f", *values)
    binary.extend(payload)

    buffer_view = {
        "buffer": 0,
        "byteOffset": byte_offset,
        "byteLength": len(payload),
    }
    gltf.setdefault("bufferViews", []).append(buffer_view)
    view_index = len(gltf["bufferViews"]) - 1

    accessor = {
        "bufferView": view_index,
        "componentType": 5126,
        "count": count,
        "type": accessor_type,
    }
    if minimum is not None:
        accessor["min"] = minimum
    if maximum is not None:
        accessor["max"] = maximum
    gltf.setdefault("accessors", []).append(accessor)
    return len(gltf["accessors"]) - 1


def translated_matrix(node: dict) -> list[float]:
    matrix = node.get("matrix")
    if matrix is None or len(matrix) != 16:
        raise ValueError(f"Node {node.get('name', '<unnamed>')} has no matrix")
    identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]
    if matrix[:12] != identity:
        raise ValueError("Drawer nodes are expected to use translation-only matrices")
    return [float(matrix[12]), float(matrix[13]), float(matrix[14])]


def add_drawers(gltf: dict, binary: bytearray) -> None:
    nodes = gltf["nodes"]
    if any(node.get("name") == "DRAWER_1_ASSEMBLY" for node in nodes):
        raise ValueError("Drawer assemblies are already present")

    cabinet = nodes[28]
    if cabinet.get("name") != "02_DRAWER_CABINET":
        raise ValueError("The expected drawer cabinet node was not found")

    # Reuse the existing front-panel cuboid and give the tray pieces the
    # cabinet's light-grey material. This keeps the model compact.
    tray_mesh = copy.deepcopy(gltf["meshes"][nodes[30]["mesh"]])
    tray_mesh["name"] = "DRAWER_TRAY_PANEL"
    for primitive in tray_mesh["primitives"]:
        primitive["material"] = 0
    gltf["meshes"].append(tray_mesh)
    tray_mesh_index = len(gltf["meshes"]) - 1

    drawer_parts = ((30, 31), (32, 33), (34, 35))
    group_indices: list[int] = []

    for drawer_number, (front_index, handle_index) in enumerate(drawer_parts, 1):
        front = nodes[front_index]
        handle = nodes[handle_index]
        origin = translated_matrix(front)
        handle_origin = translated_matrix(handle)

        front.pop("matrix")
        front["translation"] = [0.0, 0.0, 0.0]
        handle.pop("matrix")
        handle["translation"] = [
            handle_origin[0] - origin[0],
            handle_origin[1] - origin[1],
            handle_origin[2] - origin[2],
        ]

        group_index = len(nodes)
        group = {
            "name": f"DRAWER_{drawer_number}_ASSEMBLY",
            "translation": origin,
            "children": [front_index, handle_index],
        }
        nodes.append(group)
        group_indices.append(group_index)

        # The front-panel mesh measures 0.455 x 0.142 x 0.025 metres.
        # Non-uniformly scaled copies form a shallow open tray behind it.
        tray_parts = (
            (
                "BOTTOM",
                [0.0, -0.058, 0.195],
                [0.408 / 0.455, 0.012 / 0.142, 0.340 / 0.025],
            ),
            (
                "SIDE_LEFT",
                [-0.210, 0.0005, 0.195],
                [0.012 / 0.455, 0.105 / 0.142, 0.340 / 0.025],
            ),
            (
                "SIDE_RIGHT",
                [0.210, 0.0005, 0.195],
                [0.012 / 0.455, 0.105 / 0.142, 0.340 / 0.025],
            ),
            (
                "BACK",
                [0.0, 0.0005, 0.365],
                [0.432 / 0.455, 0.105 / 0.142, 0.012 / 0.025],
            ),
        )

        for part_name, translation, scale in tray_parts:
            part_index = len(nodes)
            nodes.append(
                {
                    "name": f"DRAWER_{drawer_number}_{part_name}",
                    "mesh": tray_mesh_index,
                    "translation": translation,
                    "scale": scale,
                }
            )
            group["children"].append(part_index)

    cabinet["children"] = [29, *group_indices]

    duration = 0.85
    time_accessor = append_float_accessor(
        gltf,
        binary,
        [0.0, duration],
        "SCALAR",
        2,
        minimum=[0.0],
        maximum=[duration],
    )

    animations = gltf.setdefault("animations", [])
    for drawer_number, group_index in enumerate(group_indices, 1):
        closed = nodes[group_index]["translation"]
        opened = [closed[0], closed[1], closed[2] - 0.300]

        # CUBICSPLINE stores in-tangent, value and out-tangent per keyframe.
        # Zero tangents produce a smooth ease-in/ease-out motion.
        zero = [0.0, 0.0, 0.0]
        values = [*zero, *closed, *zero, *zero, *opened, *zero]
        translation_accessor = append_float_accessor(
            gltf, binary, values, "VEC3", 6
        )
        animations.append(
            {
                "name": f"drawer-{drawer_number}",
                "samplers": [
                    {
                        "input": time_accessor,
                        "output": translation_accessor,
                        "interpolation": "CUBICSPLINE",
                    }
                ],
                "channels": [
                    {
                        "sampler": 0,
                        "target": {"node": group_index, "path": "translation"},
                    }
                ],
            }
        )

    gltf["buffers"][0]["byteLength"] = len(binary)


def write_glb(path: Path, gltf: dict, binary: bytearray) -> None:
    json_bytes = json.dumps(
        gltf, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")
    json_bytes += b" " * ((-len(json_bytes)) % 4)

    binary_chunk = bytearray(binary)
    pad4(binary_chunk)
    total_length = 12 + 8 + len(json_bytes) + 8 + len(binary_chunk)

    output = bytearray(struct.pack("<4sII", b"glTF", 2, total_length))
    output.extend(struct.pack("<I4s", len(json_bytes), JSON_CHUNK))
    output.extend(json_bytes)
    output.extend(struct.pack("<I4s", len(binary_chunk), BIN_CHUNK))
    output.extend(binary_chunk)

    temporary = path.with_suffix(".glb.tmp")
    temporary.write_bytes(output)
    temporary.replace(path)


def main() -> None:
    gltf, binary = read_glb(MODEL_PATH)
    add_drawers(gltf, binary)
    write_glb(MODEL_PATH, gltf, binary)
    print(
        f"Added 3 drawer trays and animations to {MODEL_PATH.name} "
        f"({MODEL_PATH.stat().st_size:,} bytes)."
    )


if __name__ == "__main__":
    main()
