import Foundation
import AppKit
import Vision
import UniformTypeIdentifiers
import OSLog

@main
struct FortressMacOSApp {
    static let logger = Logger(subsystem: "com.fortress.hub", category: "vision")

    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private var statusLabel: NSTextField!
    private var outputView: NSTextView!
    private var profileField: NSTextField!

    func applicationDidFinishLaunching(_ notification: Notification) {
        let contentView = NSView()
        contentView.wantsLayer = true
        contentView.layer?.backgroundColor = NSColor.black.cgColor

        let title = NSTextField(labelWithString: "Fortress Hub • Vision Intake")
        title.font = NSFont.systemFont(ofSize: 18, weight: .semibold)
        title.textColor = NSColor.labelColor
        title.translatesAutoresizingMaskIntoConstraints = false

        let subtitle = NSTextField(labelWithString: "Capture or open a receipt and send it to your local receipt pipeline.")
        subtitle.font = NSFont.systemFont(ofSize: 12)
        subtitle.textColor = NSColor.secondaryLabelColor
        subtitle.lineBreakMode = .byWordWrapping
        subtitle.maximumNumberOfLines = 2
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        let openButton = NSButton(checkboxWithTitle: "Open Receipt", target: self, action: #selector(openReceipt))
        openButton.translatesAutoresizingMaskIntoConstraints = false

        let profileLabel = NSTextField(labelWithString: "Profile ID")
        profileLabel.font = NSFont.systemFont(ofSize: 11, weight: .medium)
        profileLabel.textColor = NSColor.secondaryLabelColor
        profileLabel.translatesAutoresizingMaskIntoConstraints = false

        profileField = NSTextField(string: "")
        profileField.placeholderString = "Enter an existing profile ID"
        profileField.translatesAutoresizingMaskIntoConstraints = false

        let refreshButton = NSButton(checkboxWithTitle: "Refresh Profiles", target: self, action: #selector(refreshProfiles))
        refreshButton.translatesAutoresizingMaskIntoConstraints = false

        let runButton = NSButton(checkboxWithTitle: "Run Vision OCR", target: self, action: #selector(runVisionOCRButtonPressed))
        runButton.translatesAutoresizingMaskIntoConstraints = false

        statusLabel = NSTextField(labelWithString: "Status: ready")
        statusLabel.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        statusLabel.textColor = NSColor.systemGreen
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.identifier = NSUserInterfaceItemIdentifier("statusLabel")

        outputView = NSTextView()
        outputView.isEditable = false
        outputView.font = NSFont.monospacedSystemFont(ofSize: 11, weight: .regular)
        outputView.textColor = NSColor.textColor
        outputView.backgroundColor = NSColor.controlBackgroundColor
        outputView.translatesAutoresizingMaskIntoConstraints = false
        outputView.identifier = NSUserInterfaceItemIdentifier("outputView")

        contentView.addSubview(title)
        contentView.addSubview(subtitle)
        contentView.addSubview(openButton)
        contentView.addSubview(profileLabel)
        contentView.addSubview(profileField)
        contentView.addSubview(refreshButton)
        contentView.addSubview(runButton)
        contentView.addSubview(statusLabel)
        contentView.addSubview(outputView)

        NSLayoutConstraint.activate([
            title.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 24),
            title.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
            title.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
            subtitle.topAnchor.constraint(equalTo: title.bottomAnchor, constant: 8),
            subtitle.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            subtitle.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            openButton.topAnchor.constraint(equalTo: subtitle.bottomAnchor, constant: 20),
            openButton.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            profileLabel.topAnchor.constraint(equalTo: openButton.bottomAnchor, constant: 12),
            profileLabel.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            profileField.topAnchor.constraint(equalTo: profileLabel.bottomAnchor, constant: 6),
            profileField.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            profileField.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            refreshButton.topAnchor.constraint(equalTo: profileField.bottomAnchor, constant: 8),
            refreshButton.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            runButton.topAnchor.constraint(equalTo: refreshButton.bottomAnchor, constant: 8),
            runButton.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            statusLabel.topAnchor.constraint(equalTo: runButton.bottomAnchor, constant: 16),
            statusLabel.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            statusLabel.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            outputView.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 12),
            outputView.leadingAnchor.constraint(equalTo: title.leadingAnchor),
            outputView.trailingAnchor.constraint(equalTo: title.trailingAnchor),
            outputView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -24)
        ])

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                          styleMask: [.titled, .closable, .resizable],
                          backing: .buffered, defer: false)
        window.center()
        window.contentView = contentView
        window.title = "Fortress Hub"
        window.makeKeyAndOrderFront(nil)

        NSApp.activate(ignoringOtherApps: true)
    }

    @objc private func openReceipt() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [UTType.image]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.begin { response in
            guard response == .OK, let url = panel.urls.first else { return }
            self.updateStatus("Loaded: \(url.lastPathComponent)")
            self.runVisionOCR(for: url)
        }
    }

    @objc private func refreshProfiles() {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:4002/api/profiles")!)
        request.httpMethod = "GET"
        URLSession.shared.dataTask(with: request) { data, _, error in
            DispatchQueue.main.async {
                if let error {
                    self.updateStatus("Profile lookup failed: \(error.localizedDescription)")
                    return
                }
                guard let data else {
                    self.updateStatus("No profile data returned")
                    return
                }
                guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let profiles = json["profiles"] as? [[String: Any]] else {
                    self.updateStatus("Profiles endpoint returned an unexpected payload")
                    return
                }
                let summary = profiles.prefix(8).compactMap { profile in
                    guard let id = profile["id"], let name = profile["name"] as? String else { return nil }
                    return "\(name) (#\(id))"
                }.joined(separator: ", ")
                self.updateStatus("Available profiles: \(summary)")
            }
        }.resume()
    }

    @objc private func runVisionOCRButtonPressed() {
        updateStatus("Vision OCR ready. Use Open Receipt to begin.")
    }

    private func runVisionOCR(for url: URL) {
        let request = VNRecognizeTextRequest { request, error in
            DispatchQueue.main.async {
                if let error {
                    self.updateStatus("OCR error: \(error.localizedDescription)")
                    return
                }

                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    self.updateStatus("OCR returned no observations")
                    return
                }

                let recognizedText = self.groupedText(from: observations)
                self.updateOutput(recognizedText)
                self.updateStatus("OCR complete. Parsed \(observations.count) lines.")
                self.uploadToBackend(text: recognizedText, sourceURL: url)
            }
        }
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        guard let image = NSImage(contentsOf: url) else {
            updateStatus("Could not read image")
            return
        }

        let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
        guard let cgImage else {
            updateStatus("Could not convert image to CGImage")
            return
        }

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try handler.perform([request])
            } catch {
                DispatchQueue.main.async {
                    self.updateStatus("Vision handler failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func uploadToBackend(text: String, sourceURL: URL) {
        let profileId = profileField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !profileId.isEmpty else {
            updateStatus("Please enter a profile ID before sending OCR data")
            return
        }

        persistLocalReceipt(text: text, sourceURL: sourceURL, profileId: profileId)

        let payload = ["text": text, "source": sourceURL.lastPathComponent, "profileId": profileId]
        guard let jsonData = try? JSONSerialization.data(withJSONObject: payload, options: []) else { return }

        var request = URLRequest(url: URL(string: "http://127.0.0.1:4002/api/native-vision")!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = jsonData

        URLSession.shared.dataTask(with: request) { _, response, error in
            DispatchQueue.main.async {
                if let error {
                    self.updateStatus("Upload failed: \(error.localizedDescription)")
                    return
                }
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 || httpResponse.statusCode == 201 || httpResponse.statusCode == 202 {
                    self.updateStatus("Receipt data sent to backend.")
                } else {
                    self.updateStatus("Backend responded with an unexpected status.")
                }
            }
        }.resume()
    }

    private func persistLocalReceipt(text: String, sourceURL: URL, profileId: String) {
        struct ReceiptArchiveEntry: Codable {
            let timestamp: String
            let source: String
            let profileId: String
            let text: String
        }

        let archiveURL = self.archiveURL()
        var entries: [ReceiptArchiveEntry] = []
        if let data = try? Data(contentsOf: archiveURL), let existing = try? JSONDecoder().decode([ReceiptArchiveEntry].self, from: data) {
            entries = existing
        }

        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let entry = ReceiptArchiveEntry(timestamp: formatter.string(from: Date()), source: sourceURL.lastPathComponent, profileId: profileId, text: text)
        entries.append(entry)

        if let data = try? JSONEncoder().encode(entries) {
            try? data.write(to: archiveURL)
        }
    }

    private func archiveURL() -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("FortressHub", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent("receipts.json")
    }

    private func groupedText(from observations: [VNRecognizedTextObservation]) -> String {
        struct LineCandidate { let text: String; let y: CGFloat }
        var lines: [LineCandidate] = []

        for observation in observations {
            guard let candidate = observation.topCandidates(1).first else { continue }
            let normalizedCenterY = observation.boundingBox.midY
            let text = candidate.string
            if let last = lines.last, abs(last.y - normalizedCenterY) < 0.06 {
                lines[lines.count - 1] = LineCandidate(text: "\(last.text) \(text)", y: normalizedCenterY)
            } else {
                lines.append(LineCandidate(text: text, y: normalizedCenterY))
            }
        }

        return lines.map(\.text).joined(separator: "\n")
    }

    private func updateStatus(_ text: String) {
        FortressMacOSApp.logger.info("\(text)")
        DispatchQueue.main.async {
            self.statusLabel.stringValue = "Status: \(text)"
        }
    }

    private func updateOutput(_ text: String) {
        DispatchQueue.main.async {
            self.outputView.string = text
        }
    }
}
