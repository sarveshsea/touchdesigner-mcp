"""Original synthetic architecture fixture. Run inside TouchDesigner Textport.

No asset downloads, source execution, audio devices or external files are used.
Creation refuses an existing target. Save the returned COMP as a .tox if desired.
"""


def build(parent_path="/project1", name="architecture_example1"):
    import td

    parent = td.op(parent_path)
    if parent is None or parent.family != "COMP":
        raise ValueError("Choose an existing parent COMP")
    if parent.op(name) is not None:
        raise ValueError("Example target already exists")
    base = parent.create(td.baseCOMP, name)
    created = []
    try:
        for index, (operator_type, node_name) in enumerate(
            [
                (td.constantCHOP, "control_values1"),
                (td.mathCHOP, "control_range1"),
                (td.nullCHOP, "CONTROL_OUT1"),
                (td.noiseTOP, "pigment_source1"),
                (td.levelTOP, "pigment_grade1"),
                (td.nullTOP, "IMAGE_OUT1"),
                (td.sphereSOP, "sculpture_mesh1"),
                (td.transformSOP, "sculpture_pose1"),
                (td.nullSOP, "GEOMETRY_OUT1"),
                (td.phongMAT, "sculpture_material1"),
                (td.tableDAT, "scene_catalog1"),
                (td.baseCOMP, "mixed_subsystem1"),
            ]
        ):
            node = base.create(operator_type, node_name)
            node.nodeX, node.nodeY = (index % 3) * 200, -(index // 3) * 180
            created.append(node)
        for source, target in [(0, 1), (1, 2), (3, 4), (4, 5), (6, 7), (7, 8)]:
            created[target].inputConnectors[0].connect(created[source])
        table = created[10]
        table.appendRow(["scene", "role"])
        table.appendRow(["gravity_study", "geometry"])
        nested = created[11]
        nested.create(td.constantCHOP, "animation_values1")
        nested.create(td.constantTOP, "typography_mask1")
        if hasattr(td, "pointgeneratorPOP"):
            particles = base.create(td.pointgeneratorPOP, "particle_seed1")
            particles.nodeX, particles.nodeY = 0, -720
        return base
    except Exception:
        base.destroy()
        raise
