// The update key. `swift sign.swift pub` prints the public half, which build.sh puts in Info.plist;
// `swift sign.swift sign FILE` prints FILE's signature. The app installs an update only when the
// zip verifies against the key it shipped with, so the server alone cannot hand it code to run.
// The private half lives outside the repo: lose it and the next update has to be installed by hand.
import CryptoKit
import Foundation

let path = FileManager.default.homeDirectoryForCurrentUser.appending(path: ".config/stash/mac-update.key")
let key: Curve25519.Signing.PrivateKey
if let raw = try? Data(contentsOf: path), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: raw) {
  key = k
} else {
  key = Curve25519.Signing.PrivateKey()
  try FileManager.default.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
  try key.rawRepresentation.write(to: path, options: .atomic)
  try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
  FileHandle.standardError.write("made a new update key at \(path.path) — back it up\n".data(using: .utf8)!)
}

switch CommandLine.arguments.dropFirst().first {
case "pub":
  print(key.publicKey.rawRepresentation.base64EncodedString())
case "sign":
  let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2]))
  print(try key.signature(for: data).base64EncodedString())
default:
  FileHandle.standardError.write("usage: swift sign.swift pub | sign FILE\n".data(using: .utf8)!)
  exit(1)
}
