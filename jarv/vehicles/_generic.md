# vehicle: %(app)s

The universal key — no app is undrivable, but the door depends on what the app
exposes. This card was auto-cut (or starter-generic). Determine the drivers in
order with `vehicle probe`, then use the first one that works:

- driver: ladder      # probe → choose: osascript | ui | see
- osascript:          # a real AppleScript dictionary?  `osascript -e 'tell app "%(app)s" to count windows'`
- ui:                 # System Events tree + keystrokes (needs Accessibility):
                        `!kit app probe %(app)s` then `!kit app ui %(app)s`
- see:                # eyes + touch, works on ANY app:
                        `!kit see screen` / `!kit see app %(app)s` / `!kit see text <label>` / `!kit see click <x> <y>`

Doctrine:
  1. Probe first — read what the app exposes before touching anything
     (`!kit vehicle probe %(app)s`).
  2. Prefer scriptable doors: osascript dictionary > System Events UI > see
     (OCR clicks are the slowest and least certain).
  3. If the app bundles its own scripting runtime (Blender/bpy, Maya/mel,
     Node, Excel/VBA), that is always the strongest key — look for it.
  4. Learn the layout via `app ui`/`see` before acting; iterate one small step
     at a time.