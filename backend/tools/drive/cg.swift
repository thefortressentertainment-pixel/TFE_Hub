import Foundation
import AppKit
import CoreGraphics

// jarv-drive-cg — CoreGraphics event synthesizer. Lets JARV move/click/drag/
// the mouse, scroll, type text and press key combos, activate apps and inspect
// screens/processes. Mouse/keys need Accessibility (AXIsProcessTrusted).

struct ScreenInfo {
  let pxW: Int, pxH: Int, ptW: Int, ptH: Int, scale: Double
}

func screens() -> [ScreenInfo] {
  NSScreen.screens.map { s in
    let f = s.frame
    let b = s.backingScaleFactor
    return ScreenInfo(pxW: Int(f.width * b), pxH: Int(f.height * b), ptW: Int(f.width), ptH: Int(f.height), scale: b)
  }
}

func post(_ ev: CGEvent) { ev.post(tap: .cghidEventTap) }

func mouseEvent(_ type: CGEventType, _ x: Double, _ y: Double) -> CGEvent {
  CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left)!
}

func scrollEvent(_ dx: Int32, _ dy: Int32) -> CGEvent {
  let ev = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)!
  return ev
}

func keyCodeFor(_ s: String) -> CGKeyCode? {
  let map: [String: CGKeyCode] = [
    "return": 36, "enter": 36, "tab": 48, "space": 49, "esc": 53, "escape": 53,
    "delete": 51, "backspace": 51, "forwarddelete": 117,
    "up": 126, "down": 125, "left": 123, "right": 124, "home": 115, "end": 119, "pgup": 116, "pgdn": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111, "f13": 105, "f14": 107, "f15": 113,
    "cmd": 55, "command": 55, "shift": 56, "ctrl": 59, "control": 59, "opt": 58, "option": 58, "alt": 58,
    "caps": 57, "help": 114,
  ]
  if let c = map[s.lowercased()] { return c }
  if s.count == 1, let scal = s.unicodeScalars.first, scal.value < 128 {
    return CGKeyCode(truncatingIfNeeded: scal.value)
  }
  return nil
}

func flagsFor(_ names: [String]) -> CGEventFlags {
  var f = CGEventFlags()
  for n in names {
    switch n.lowercased() {
    case "cmd", "command": f.insert(.maskCommand)
    case "shift": f.insert(.maskShift)
    case "ctrl", "control": f.insert(.maskControl)
    case "opt", "option", "alt": f.insert(.maskAlternate)
    case "fn": f.insert(.maskSecondaryFn)
    default: break
    }
  }
  return f
}

func keyCombo(_ spec: String) {
  let parts = spec.split(separator: "-").map(String.init)
  let mods = parts.prefix(parts.count - 1)
  guard let last = parts.last else { return }
  let flags = flagsFor(Array(mods))
  if let code = keyCodeFor(last) {
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)!
    down.flags = flags
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)!
    up.flags = flags
    post(down); post(up)
  } else {
    typeText(last, flags)
  }
}

func typeText(_ text: String, _ flags: CGEventFlags = []) {
  var chars = Array(text.unicodeScalars).map { UniChar(truncatingIfNeeded: $0.value) }
  let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)!
  down.flags = flags
  down.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
  let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)!
  up.flags = flags
  up.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: &chars)
  post(down); post(up)
}

let args = CommandLine.arguments
guard args.count >= 2 else {
  print("usage: jarv-drive-cg status|front|apps|activate <name>|click <x> <y>|right <x> <y>|move <x> <y>|drag <x1> <y1> <x2> <y2>|scroll <dx> <dy>|type <text>|key <combo>")
  exit(2)
}

switch args[1] {
case "status":
  let ax = AXIsProcessTrusted()
  let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "none"
  print("{\"axTrusted\":\(ax),")
  print("\"screens\":[")
  let sc = screens()
  for (i, s) in sc.enumerated() {
    print("{\"pxW\":\(s.pxW),\"pxH\":\(s.pxH),\"ptW\":\(s.ptW),\"ptH\":\(s.ptH),\"scale\":\(s.scale)}\(i < sc.count - 1 ? "," : "")")
  }
  print("],")
  print("\"frontmost\":\"\(front)\",\"running\":[")
  let apps = NSWorkspace.shared.runningApplications.compactMap { $0.localizedName }
  for (i, name) in apps.enumerated() {
    print("\"\(name)\"\(i < apps.count - 1 ? "," : "")")
  }
  print("]}")
case "front":
  print(NSWorkspace.shared.frontmostApplication?.localizedName ?? "none")
case "apps":
  for app in NSWorkspace.shared.runningApplications where app.localizedName != nil {
    print("\(app.localizedName!)")
  }
case "activate":
  guard args.count >= 3 else { print("ERR need app name"); exit(1) }
  let name = args[2]
  let apps = NSWorkspace.shared.runningApplications.filter { $0.localizedName?.lowercased() == name.lowercased() || $0.bundleIdentifier?.lowercased() == name.lowercased() }
  if apps.isEmpty { print("ERR app not running: \(name)"); exit(1) }
  apps.first!.activate(options: [.activateAllWindows, .activateIgnoringOtherApps])
  usleep(120_000)
  print("OK activated \(name)")
case "click":
  guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]) else { exit(1) }
  post(mouseEvent(.mouseMoved, x, y)); usleep(40_000)
  post(mouseEvent(.leftMouseDown, x, y)); usleep(60_000); post(mouseEvent(.leftMouseUp, x, y))
  print("OK click \(x),\(y)")
case "right":
  guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]) else { exit(1) }
  post(mouseEvent(.mouseMoved, x, y)); usleep(40_000)
  let d = CGEvent(mouseEventSource: nil, mouseType: .rightMouseDown, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .right)!
  d.post(tap: .cghidEventTap); usleep(60_000)
  let u = CGEvent(mouseEventSource: nil, mouseType: .rightMouseUp, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .right)!
  u.post(tap: .cghidEventTap)
  print("OK right \(x),\(y)")
case "move":
  guard args.count == 4, let x = Double(args[2]), let y = Double(args[3]) else { exit(1) }
  post(mouseEvent(.mouseMoved, x, y)); usleep(40_000); print("OK move \(x),\(y)")
case "drag":
  guard args.count == 6, let x1 = Double(args[2]), let y1 = Double(args[3]), let x2 = Double(args[4]), let y2 = Double(args[5]) else { exit(1) }
  post(mouseEvent(.mouseMoved, x1, y1)); usleep(60_000)
  post(mouseEvent(.leftMouseDown, x1, y1)); usleep(60_000)
  let steps = 12
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    post(mouseEvent(.leftMouseDragged, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t))
    usleep(16_000)
  }
  post(mouseEvent(.leftMouseUp, x2, y2)); usleep(40_000)
  print("OK drag \(x1),\(y1)->\(x2),\(y2)")
case "scroll":
  guard args.count == 4, let dx = Int32(args[2]), let dy = Int32(args[3]) else { exit(1) }
  let ev = scrollEvent(dx, dy); post(ev); usleep(40_000); print("OK scroll \(dx),\(dy)")
case "type":
  guard args.count >= 3 else { exit(1) }
  let text = args.dropFirst(2).joined(separator: " ")
  typeText(text); usleep(80_000); print("OK typed \(text.count) chars")
case "key":
  guard args.count >= 3 else { exit(1) }
  keyCombo(args[2]); usleep(60_000); print("OK key \(args[2])")
default:
  print("ERR unknown subcommand \(args[1])"); exit(1)
}