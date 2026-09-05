import Foundation
import AppKit
import Vision

// jarv-drive-ocr — pixel-accurate screen reading for JARV. Takes a full-screen
// snapshot (main display) and returns every text run with its bounding box in
// LOGICAL POINTS (CGEvent space, origin top-left), plus the display scale and
// the (normalized 0..1) box so the caller can map between OCR and screen.

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard !path.isEmpty, let img = NSImage(contentsOfFile: path), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("{\"error\":\"cannot read image\"}"); exit(1)
}

let pxW = cg.width, pxH = cg.height
let mainScreen = NSScreen.main ?? NSScreen.screens.first
let ptW: Double = mainScreen.map { Double($0.frame.width) } ?? Double(pxW)
let ptH: Double = mainScreen.map { Double($0.frame.height) } ?? Double(pxH)
let scale = max(0.5, Double(pxW) / ptW)

let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
try VNImageRequestHandler(cgImage: cg).perform([req])

let dpxW = Double(pxW), dpxH = Double(pxH)
var lines: [[String: Any]] = []
let results = req.results ?? []
for obs in results {
  guard let cand = obs.topCandidates(1).first else { continue }
  let box = obs.boundingBox // normalized, origin bottom-left
  let cx = Double(box.midX) * dpxW
  let cyPix = Double(1 - box.midY) * dpxH       // pixel y, top-origin
  let wpx = Double(box.width) * dpxW
  let hpx = Double(box.height) * dpxH
  lines.append([
    "t": cand.string,
    "px": Int(cx / scale), "py": Int(cyPix / scale),  // centre, points
    "pw": Int(wpx / scale), "ph": Int(hpx / scale),   // size, points
    "box": [box.minX, box.minY, box.width, box.height],
  ])
}
// topmost-first, refine: keep the 90 visually tallest/biggest lines
lines.sort { a, b in
  let ay = (a["py"] as? Int) ?? 0, by = (b["py"] as? Int) ?? 0
  return ay != by ? ay < by : ((a["pw"] as? Int) ?? 0) > ((b["pw"] as? Int) ?? 0)
}
if lines.count > 90 { lines = Array(lines.prefix(90)) }

var out = "{"
out += "\"scale\":\(scale),"
out += "\"pxW\":\(pxW),\"pxH\":\(pxH),"
out += "\"ptW\":\(Int(ptW)),\"ptH\":\(Int(ptH)),"
out += "\"lines\":["
for (i, l) in lines.enumerated() {
  let t = (l["t"] as? String ?? "").replacingOccurrences(of: "\"", with: "'")
  out += "{\"t\":\"\(t)\",\"px\":\(l["px"] ?? 0),\"py\":\(l["py"] ?? 0),\"pw\":\(l["pw"] ?? 0),\"ph\":\(l["ph"] ?? 0),\"x0\":\((l["box"] as? [Double] ?? [0,0,0,0])[0]),\"y0\":\((l["box"] as? [Double] ?? [0,0,0,0])[1])}"
  out += (i < lines.count - 1 ? "," : "")
}
out += "]}"
print(out)