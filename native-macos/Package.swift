// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FortressMacOS",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "FortressMacOS", targets: ["FortressMacOS"])
    ],
    targets: [
        .executableTarget(
            name: "FortressMacOS",
            dependencies: []
        )
    ]
)
