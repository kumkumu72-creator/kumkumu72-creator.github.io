"""Add four animated drawers to the detailed WATO EX-35 web GLB.

The archive model was exported as one mesh.  The four visible drawer fronts
are therefore separated by their stable model-space bounds, put into their own
meshes, and grouped with lightweight tray geometry.  The resulting animation
names are consumed by the page's model-viewer controls.
"""

from __future__ import annotations

import copy
import json
import struct
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_PATH = ROOT / "assets/models/wato-ex35/WATO_EX35_web.glb"
JSON_CHUNK = b"JSON"
BIN_CHUNK = b"BIN\x00"

# Raw (pre node-transform) coordinate ranges of all four drawer fronts.
DRAWER_Z_RANGES = ((6.95, 8.33), (5.47, 6.96), (3.99, 5.47), (2.50, 3.99))
DRAWER_X_RANGE = (-2.71, 3.81)
DRAWER_Y_RANGE = (-2.64, -2.01)

# Exact front bounds measured from the separated archive geometry.  Tray walls
# use the same vertical bounds so the fascia cannot appear to hang below them.
DRAWER_FRONT_BOUNDS = (
    (6.9712157, 8.3141850),
    (5.4881230, 6.9416633),
    (4.0050306, 5.4585705),
    (2.5219371, 3.9754765),
)
TRAY_Y = -0.52
TRAY_DEPTH = 3.04


def read_glb(path: Path) -> tuple[dict, bytearray]:
    data = path.read_bytes()
    magic, version, total_length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total_length != len(data):
        raise ValueError("Expected a valid glTF 2.0 binary file")

    json_length, json_type = struct.unpack_from("<I4s", data, 12)
    if json_type != JSON_CHUNK:
        raise ValueError("The first GLB chunk must be JSON")
    gltf = json.loads(data[20 : 20 + json_length].decode("utf-8").rstrip(" \x00"))

    binary_header = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<I4s", data, binary_header)
    if binary_type != BIN_CHUNK:
        raise ValueError("The second GLB chunk must be binary")
    binary_start = binary_header + 8
    declared = gltf["buffers"][0]["byteLength"]
    if declared > binary_length:
        raise ValueError("The GLB binary buffer is shorter than declared")
    return gltf, bytearray(data[binary_start : binary_start + declared])


def pad4(data: bytearray, fill: int = 0) -> None:
    data.extend(bytes([fill]) * ((-len(data)) % 4))


def accessor_values(gltf: dict, binary: bytearray, accessor_index: int):
    accessor = gltf["accessors"][accessor_index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    if "byteStride" in view:
        raise ValueError("Interleaved accessors are not supported")
    components = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    format_char, byte_size = {
        5121: ("B", 1),
        5123: ("H", 2),
        5125: ("I", 4),
        5126: ("f", 4),
    }[accessor["componentType"]]
    offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    count = accessor["count"] * components
    return struct.unpack_from(f"<{count}{format_char}", binary, offset), components, byte_size


def append_accessor(
    gltf: dict,
    binary: bytearray,
    values,
    component_type: int,
    accessor_type: str,
    count: int,
    *,
    minimum=None,
    maximum=None,
) -> int:
    format_char = {5121: "B", 5123: "H", 5125: "I", 5126: "f"}[component_type]
    pad4(binary)
    offset = len(binary)
    payload = struct.pack(f"<{len(values)}{format_char}", *values)
    binary.extend(payload)
    gltf.setdefault("bufferViews", []).append(
        {"buffer": 0, "byteOffset": offset, "byteLength": len(payload)}
    )
    accessor = {
        "bufferView": len(gltf["bufferViews"]) - 1,
        "componentType": component_type,
        "count": count,
        "type": accessor_type,
    }
    if minimum is not None:
        accessor["min"] = minimum
    if maximum is not None:
        accessor["max"] = maximum
    gltf.setdefault("accessors", []).append(accessor)
    return len(gltf["accessors"]) - 1


def append_indices(gltf: dict, binary: bytearray, indices: list[int]) -> int:
    component_type = 5123 if max(indices, default=0) <= 65535 else 5125
    return append_accessor(
        gltf, binary, indices, component_type, "SCALAR", len(indices)
    )


def cube_mesh(gltf: dict, binary: bytearray, material_index: int) -> int:
    # Four independent vertices per face keep the tray edges crisp.
    faces = (
        ((-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1), (0, 0, 1)),
        ((1, -1, -1), (-1, -1, -1), (-1, 1, -1), (1, 1, -1), (0, 0, -1)),
        ((-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1), (-1, 0, 0)),
        ((1, -1, 1), (1, -1, -1), (1, 1, -1), (1, 1, 1), (1, 0, 0)),
        ((-1, 1, 1), (1, 1, 1), (1, 1, -1), (-1, 1, -1), (0, 1, 0)),
        ((-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1), (0, -1, 0)),
    )
    positions: list[float] = []
    normals: list[float] = []
    indices: list[int] = []
    for face_index, (*corners, normal) in enumerate(faces):
        for corner in corners:
            positions.extend(value * 0.5 for value in corner)
            normals.extend(normal)
        start = face_index * 4
        indices.extend((start, start + 1, start + 2, start, start + 2, start + 3))

    position_accessor = append_accessor(
        gltf, binary, positions, 5126, "VEC3", 24,
        minimum=[-0.5, -0.5, -0.5], maximum=[0.5, 0.5, 0.5],
    )
    normal_accessor = append_accessor(gltf, binary, normals, 5126, "VEC3", 24)
    index_accessor = append_indices(gltf, binary, indices)
    gltf["meshes"].append(
        {
            "name": "DRAWER_TRAY_CUBOID",
            "primitives": [{
                "attributes": {"POSITION": position_accessor, "NORMAL": normal_accessor},
                "indices": index_accessor,
                "material": material_index,
            }],
        }
    )
    return len(gltf["meshes"]) - 1


def add_drawers(gltf: dict, binary: bytearray) -> int:
    existing_drawers = 0
    for drawer_number in range(1, 5):
        if any(
            node.get("name") == f"DRAWER_{drawer_number}_ASSEMBLY"
            for node in gltf["nodes"]
        ):
            existing_drawers += 1
        else:
            break
    if existing_drawers == 4:
        return 0
    if existing_drawers not in (0, 3):
        raise ValueError(f"Unsupported partial drawer set: {existing_drawers}")
    if existing_drawers == 0 and len(gltf.get("meshes", [])) != 1:
        raise ValueError("Expected the detailed archive model to contain one mesh")

    model_node = gltf["nodes"][0]
    body_primitive = gltf["meshes"][0]["primitives"][0]
    position_values, position_components, _ = accessor_values(
        gltf, binary, body_primitive["attributes"]["POSITION"]
    )
    index_values, _, _ = accessor_values(gltf, binary, body_primitive["indices"])
    if position_components != 3 or len(index_values) % 3:
        raise ValueError("Unexpected body primitive layout")

    positions = [position_values[i : i + 3] for i in range(0, len(position_values), 3)]
    drawer_indices: list[list[int]] = [[] for _ in DRAWER_Z_RANGES]
    static_indices: list[int] = []

    for offset in range(0, len(index_values), 3):
        triangle = tuple(int(value) for value in index_values[offset : offset + 3])
        centroid = [sum(positions[index][axis] for index in triangle) / 3 for axis in range(3)]
        drawer_number = None
        if DRAWER_X_RANGE[0] < centroid[0] < DRAWER_X_RANGE[1] and DRAWER_Y_RANGE[0] < centroid[1] < DRAWER_Y_RANGE[1]:
            for number, (low, high) in enumerate(DRAWER_Z_RANGES):
                if number < existing_drawers:
                    continue
                if low < centroid[2] < high:
                    drawer_number = number
                    break
        if drawer_number is None:
            static_indices.extend(triangle)
        else:
            drawer_indices[drawer_number].extend(triangle)

    face_counts = [len(indices) // 3 for indices in drawer_indices]
    expected_counts = [908, 1420, 1420, 1420]
    expected_counts[:existing_drawers] = [0] * existing_drawers
    if face_counts != expected_counts:
        raise ValueError(f"Drawer geometry signature changed: {face_counts}")

    body_primitive["indices"] = append_indices(gltf, binary, static_indices)
    front_mesh_indices: list[tuple[int, int]] = []

    def append_front_mesh(drawer_number: int, indices: list[int]) -> None:
        primitive = copy.deepcopy(body_primitive)
        primitive["indices"] = append_indices(gltf, binary, indices)
        gltf["meshes"].append(
            {"name": f"DRAWER_{drawer_number}_FRONT", "primitives": [primitive]}
        )
        front_mesh_indices.append((drawer_number, len(gltf["meshes"]) - 1))

    # Preserve stable mesh IDs used by model-viewer's click mapping:
    # fronts 1-3 are meshes 1-3, the shared tray is mesh 4, front 4 is mesh 5.
    for drawer_number, indices in enumerate(drawer_indices[:3], 1):
        if indices:
            append_front_mesh(drawer_number, indices)

    if existing_drawers:
        tray_mesh_index = next(
            index
            for index, mesh in enumerate(gltf["meshes"])
            if mesh.get("name") == "DRAWER_TRAY_CUBOID"
        )
    else:
        tray_mesh_index = cube_mesh(gltf, binary, body_primitive.get("material", 0))

    if drawer_indices[3]:
        append_front_mesh(4, drawer_indices[3])

    group_indices: list[int] = []
    animation_groups: list[tuple[int, int]] = []
    drawer_centres = tuple((low + high) / 2 for low, high in DRAWER_FRONT_BOUNDS)
    drawer_heights = tuple(high - low for low, high in DRAWER_FRONT_BOUNDS)

    for drawer_number, front_mesh_index in front_mesh_indices:
        centre_z = drawer_centres[drawer_number - 1]
        height = drawer_heights[drawer_number - 1]
        front_node = len(gltf["nodes"])
        gltf["nodes"].append(
            {"name": f"DRAWER_{drawer_number}_FRONT", "mesh": front_mesh_index}
        )
        group_index = len(gltf["nodes"])
        group = {
            "name": f"DRAWER_{drawer_number}_ASSEMBLY",
            "translation": [0.0, 0.0, 0.0],
            "children": [front_node],
        }
        gltf["nodes"].append(group)
        group_indices.append(group_index)
        animation_groups.append((drawer_number, group_index))

        tray_parts = (
            ("BOTTOM", [0.548, TRAY_Y, centre_z - height / 2 + 0.08], [6.05, TRAY_DEPTH, 0.16]),
            ("SIDE_LEFT", [-2.43, TRAY_Y, centre_z], [0.14, TRAY_DEPTH, height]),
            ("SIDE_RIGHT", [3.53, TRAY_Y, centre_z], [0.14, TRAY_DEPTH, height]),
            ("BACK", [0.548, 1.0, centre_z], [6.05, 0.14, height]),
        )
        for part_name, translation, scale in tray_parts:
            part_node = len(gltf["nodes"])
            gltf["nodes"].append(
                {
                    "name": f"DRAWER_{drawer_number}_{part_name}",
                    "mesh": tray_mesh_index,
                    "translation": translation,
                    "scale": scale,
                }
            )
            group["children"].append(part_node)

    model_node["children"] = [*model_node.get("children", []), *group_indices]

    duration = 0.85
    time_accessor = append_accessor(
        gltf, binary, [0.0, duration], 5126, "SCALAR", 2,
        minimum=[0.0], maximum=[duration],
    )
    for drawer_number, group_index in animation_groups:
        zero = [0.0, 0.0, 0.0]
        opened = [0.0, -3.1, 0.0]
        # CUBICSPLINE: in tangent, value and out tangent for each keyframe.
        values = [*zero, *zero, *zero, *zero, *opened, *zero]
        output_accessor = append_accessor(gltf, binary, values, 5126, "VEC3", 6)
        gltf.setdefault("animations", []).append(
            {
                "name": f"drawer-{drawer_number}",
                "samplers": [{
                    "input": time_accessor,
                    "output": output_accessor,
                    "interpolation": "CUBICSPLINE",
                }],
                "channels": [{
                    "sampler": 0,
                    "target": {"node": group_index, "path": "translation"},
                }],
            }
        )

    gltf["buffers"][0]["byteLength"] = len(binary)
    return len(animation_groups)


def align_drawer_trays(gltf: dict) -> None:
    """Attach every existing tray flush to its original front geometry."""
    nodes = {node.get("name"): node for node in gltf["nodes"]}
    for drawer_number, (low, high) in enumerate(DRAWER_FRONT_BOUNDS, 1):
        centre_z = (low + high) / 2
        height = high - low
        expected = {
            "BOTTOM": ([0.548, TRAY_Y, low + 0.08], [6.05, TRAY_DEPTH, 0.16]),
            "SIDE_LEFT": ([-2.43, TRAY_Y, centre_z], [0.14, TRAY_DEPTH, height]),
            "SIDE_RIGHT": ([3.53, TRAY_Y, centre_z], [0.14, TRAY_DEPTH, height]),
            "BACK": ([0.548, 1.0, centre_z], [6.05, 0.14, height]),
        }
        for part_name, (translation, scale) in expected.items():
            node_name = f"DRAWER_{drawer_number}_{part_name}"
            if node_name not in nodes:
                raise ValueError(f"Expected drawer tray node {node_name}")
            nodes[node_name]["translation"] = translation
            nodes[node_name]["scale"] = scale


def write_glb(path: Path, gltf: dict, binary: bytearray) -> None:
    json_bytes = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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
    added = add_drawers(gltf, binary)
    align_drawer_trays(gltf)
    write_glb(MODEL_PATH, gltf, binary)
    print(
        f"Added {added} animated drawer(s) and aligned 4 trays in {MODEL_PATH} "
        f"({MODEL_PATH.stat().st_size:,} bytes)"
    )


if __name__ == "__main__":
    main()
