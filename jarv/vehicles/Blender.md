# vehicle: Blender

A full 3D suite. The strong key is its BUNDLED python (bpy — Blender's own
python API): drive the app from inside its own runtime, no UI scripting needed.
AppleScript dictionary: none. Use console first, UI/see only if unusable.

- driver: console      # bundled python/bpy — the pristine key
- binary: /Applications/Blender.app/Contents/MacOS/Blender
- headless: <binary> --background --factory-startup --python-expr '<bpy src>'
- cockpit:  <binary> --background --python jarv/vehicles/blender_server.py
  (park a live server, then `vehicle drive Blender -- <bpy src>` routes to it;
  the socket is ~/.jarv/vehicles/blender.sock — unix only, no network)

Key snippets:
  # version / sanity
  import bpy; result = bpy.app.version_string
  # clear a scene down / fresh cubic grid
  bpy.ops.wm.read_factory_settings(use_empty=True)      # full reset, nothing loaded
  bpy.ops.object.select_all(action='SELECT')
  bpy.ops.object.delete(use_global=False)
  bpy.ops.mesh.primitive_cube_add(size=2)               # add a cube at origin
  bpy.context.object.name = "KeyCube"
  # export
  bpy.ops.export_scene.fbx(filepath="/Users/tfe/out.fbx")
  bpy.ops.wm.obj_export(filepath="/Users/tfe/out.obj")
  bpy.context.scene.render.filepath = "/Users/tfe/out.png"
  bpy.ops.render.render(write_still=True)
  # ask
  result = [(o.name, o.type, tuple(o.location)) for o in bpy.data.objects]

Doctrine:
  1. VIBE, DON'T CODE: use the gearbox verbs the driver expands for you —
     `clear` · `add cube|sphere|plane|cylinder|torus|light|camera` (slots:
     size=, radius=, at=x,y,z, color=<name>, name=, kind=point|sun|area,
     energy=) · `move <obj> to=x,y,z` · `scale <obj> to=|by=` ·
     `rotate <obj> to=deg` · `rename <old> as <new>` · `color <obj> c=<name>`
     · `render to=<file>` (slots: w=, h=) · `export obj|fbx|stl to=<file>`
     (no extension → Desktop/jarv-export) · `list [of=mesh]` · `count [of=mesh]`
     E.g. `!kit vehicle drive Blender -- add cube size=2 at=0,0,1 color=red name=KeyCube`.
  2. ALWAYS use --background for one-shot ops (render, bake, export, batch) — no
     GUI, deterministic, fast. The GUI stays untouched.
  3. For an interactive or long-running session, park a cockpit server, then
     drive it slice-by-slice: ONE live Blender, state persists between requests
     (`vehicle cockpit Blender`, then gear verbs just keep applying — rename the
     thing you added, move it, count the scene). One task per request; set
     `result =` to get data back; errors come back as {"err": traceback}.
  4. Never drive Blender's own UI when bpy can do it; bpy is the key.
  5. import bpy works only under the bundled python — use that binary, never
     the Homebrew python.