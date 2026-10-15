// Stash for macOS: one window, one WKWebView on the deployed app. Everything the app is lives on
// the server and in this web view's own localStorage; this file only supplies what a browser tab
// would have — a menu bar, file pickers, downloads, and links that leave in the default browser —
// plus the one thing a tab cannot: measuring the disk for the Disk tool, which never deletes.
// ponytail: no Xcode project, `macos/build.sh` compiles this with swiftc.
import AppKit
import WebKit

// `defaults write xyz.pyvno.stash url http://localhost:5173` points it at a dev server.
let home = URL(string: UserDefaults.standard.string(forKey: "url") ?? "https://stash.pyvno.xyz")!

@MainActor
final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
  WKScriptMessageHandlerWithReply {
  var window: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ note: Notification) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()   // persistent: localStorage and the session cookie survive a quit
    // its presence is also how the page knows it is in the app and offers the Disk tool
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "disk")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    web.isInspectable = true

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Stash"
    window.isReleasedWhenClosed = false
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("main")
    window.makeKeyAndOrderFront(nil)

    NSApp.mainMenu = menu()
    web.load(URLRequest(url: home))
  }

  // Closing the window keeps the app; clicking the Dock icon brings it back, as Mail does.
  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // MARK: navigation

  func webView(_ web: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
    if action.shouldPerformDownload { return .download }
    if let url = action.request.url, action.navigationType == .linkActivated, url.host != home.host {
      openOutside(url)
      return .cancel
    }
    return .allow
  }

  func webView(_ web: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
    response.canShowMIMEType ? .allow : .download
  }

  func webView(_ web: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ web: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  // target="_blank" — a link out of a note or the inspector — opens in the default browser.
  func webView(_ web: WKWebView, createWebViewWith config: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { openOutside(url) }
    return nil
  }

  // Note text comes from synced data, so a link in it must not reach file:// or a custom scheme's app.
  func openOutside(_ url: URL) {
    guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
    NSWorkspace.shared.open(url)
  }

  // MARK: files

  func webView(_ web: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
               initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    return panel.runModal() == .OK ? panel.urls : nil
  }

  func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                suggestedFilename: String) async -> URL? {
    let panel = NSSavePanel()
    panel.nameFieldStringValue = suggestedFilename
    panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
    guard panel.runModal() == .OK, let url = panel.url else { return nil }
    try? FileManager.default.removeItem(at: url)   // the panel already asked about replacing it
    return url
  }

  // MARK: disk

  // Read-only on purpose: it measures, shows a path in Finder, or copies text. Removing anything is
  // the script the page builds, which the user reads and runs in Terminal themselves.
  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
    guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == home.host,
          let body = message.body as? [String: Any] else { return (nil, "refused") }
    switch body["op"] as? String {
    case "scan":
      let scan = Scan(paths: body["paths"] as? [String] ?? [], names: body["names"] as? [String] ?? [])
      return (await Task.detached { scan.run() }.value, nil)
    case "reveal":
      guard let path = body["path"] as? String else { return (nil, "no path") }
      NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: Scan.expand(path))])
      return (true, nil)
    case "copy":
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(body["text"] as? String ?? "", forType: .string)
      return (true, nil)
    case "fda":
      NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!)
      return (true, nil)
    default:
      return (nil, "unknown op")
    }
  }

  // MARK: menu

  @objc func reload() { web.load(URLRequest(url: home)) }
  // menu items take their keys before the page does, so they hand the page an event instead
  @objc func palette() { tell("palette") }
  @objc func settings() { tell("settings") }
  func tell(_ what: String) {
    web.evaluateJavaScript("dispatchEvent(new CustomEvent('stash:menu', { detail: '\(what)' }))")
  }

  func menu() -> NSMenu {
    let bar = NSMenu()
    func add(_ title: String, _ items: [NSMenuItem]) {
      let top = NSMenuItem()
      top.submenu = NSMenu(title: title)
      items.forEach(top.submenu!.addItem)
      bar.addItem(top)
    }
    func mine(_ i: NSMenuItem) -> NSMenuItem { i.target = self; return i }
    func item(_ title: String, _ action: Selector, _ key: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
      let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
      i.keyEquivalentModifierMask = mods
      return i
    }
    add("Stash", [
      item("About Stash", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""),
      .separator(),
      mine(item("Settings…", #selector(settings), ",")),
      .separator(),
      item("Hide Stash", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:)), ""),
      .separator(),
      item("Quit Stash", #selector(NSApplication.terminate(_:)), "q"),
    ])
    // Without these, ⌘C / ⌘V / ⌘Z never reach the web view.
    add("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])
    add("View", [
      mine(item("Commands…", #selector(palette), "k")),
      mine(item("Reload", #selector(reload), "r")),
      item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]),
    ])
    add("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Close", #selector(NSWindow.performClose(_:)), "w"),
    ])
    return bar
  }
}

/// One walk of the home folder: every folder's size, a tree of the ones worth drawing, and the sizes
/// of the paths and folder names the page's cleanup rules asked about.
final class Scan: @unchecked Sendable {
  struct Node: Encodable { let n: String; let s: Int64; let k: [Node]? }
  struct Out: Encodable { let tree: Node; let hits: [String: Int64]; let total: Int64; let free: Int64; let unreadable: Int }

  static let root = FileManager.default.homeDirectoryForCurrentUser.path
  static func expand(_ p: String) -> String { p.hasPrefix("~/") ? root + p.dropFirst(1) : p }
  static let keys: [URLResourceKey] = [.isDirectoryKey, .isSymbolicLinkKey, .totalFileAllocatedSizeKey]
  // personal-data stores: tiny, and reading them asks for Contacts or Calendars access, which a
  // disk map has no business asking for
  static let skip: Set<String> = ["~/Library/Application Support/AddressBook", "~/Library/Calendars",
    // cloud drives: listing one asks the provider over the network, and what it holds is in the cloud
    "~/Library/CloudStorage", "~/Library/Mobile Documents"]

  let paths: Set<String>, names: Set<String>
  let lock = NSLock()
  var hits: [String: Int64] = [:], unreadable = 0

  init(paths: [String], names: [String]) { self.paths = Set(paths); self.names = Set(names) }

  func run() -> String {
    let tree = walk(URL(fileURLWithPath: Scan.root), "~", depth: 0, inHit: false)
    let v = try? URL(fileURLWithPath: Scan.root).resourceValues(forKeys: [.volumeTotalCapacityKey, .volumeAvailableCapacityForImportantUsageKey])
    let out = Out(tree: tree, hits: hits, total: Int64(v?.volumeTotalCapacity ?? 0),
                  free: v?.volumeAvailableCapacityForImportantUsage ?? 0, unreadable: unreadable)
    return String(decoding: (try? JSONEncoder().encode(out)) ?? Data(), as: UTF8.self)
  }

  func walk(_ url: URL, _ rel: String, depth: Int, inHit: Bool) -> Node {
    let name = depth == 0 ? "~" : url.lastPathComponent
    if Scan.skip.contains(rel) { return Node(n: name, s: 0, k: nil) }
    guard let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: Scan.keys) else {
      lock.withLock { unreadable += 1 }
      return Node(n: name, s: 0, k: nil)
    }
    let hit = paths.contains(rel) || (!inHit && names.contains(name))
    func visit(_ item: URL) -> Node {
      let v = try? item.resourceValues(forKeys: Set(Scan.keys))
      if v?.isDirectory == true && v?.isSymbolicLink != true {
        // under any hit, a node_modules is already counted — in the Yarn cache, in the Trash
        return walk(item, rel + "/" + item.lastPathComponent, depth: depth + 1, inHit: inHit || hit)
      }
      return Node(n: item.lastPathComponent, s: Int64(v?.totalFileAllocatedSize ?? 0), k: nil)
    }
    var kids: [Node]
    if depth == 0 {   // the top level in parallel: Library alone is most of the wait, but not all of it
      var slots = [Node?](repeating: nil, count: items.count)
      let fill = NSLock()
      DispatchQueue.concurrentPerform(iterations: items.count) { i in
        let n = visit(items[i])
        fill.withLock { slots[i] = n }
      }
      kids = slots.compactMap { $0 }
    } else {
      kids = items.map(visit)
    }
    let size = kids.reduce(0) { $0 + $1.s }
    if hit { lock.withLock { hits[rel] = size } }
    // only what the page could draw: 1% of this folder and 10 MB at least, the biggest 40
    let floor = max(size / 100, 10_000_000)
    let kept = depth < 8 ? Array(kids.filter { $0.s >= floor }.sorted { $0.s > $1.s }.prefix(40)) : []
    return Node(n: name, s: size, k: kept.isEmpty ? nil : kept)
  }
}

MainActor.assumeIsolated {
  let delegate = App()
  NSApplication.shared.delegate = delegate
  NSApplication.shared.setActivationPolicy(.regular)
  NSApplication.shared.run()
}
