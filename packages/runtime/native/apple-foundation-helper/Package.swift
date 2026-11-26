// swift-tools-version: 6.2

import PackageDescription

let package = Package(
  name: "OpenAdminOSAppleFoundationHelper",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .executable(
      name: "openadminos-apple-foundation-helper",
      targets: ["OpenAdminOSAppleFoundationHelper"]
    )
  ],
  targets: [
    .executableTarget(
      name: "OpenAdminOSAppleFoundationHelper"
    )
  ]
)
