// Stash for macOS: one window, one WKWebView on the deployed app. Everything the app is lives on
// the server and in this web view's own localStorage; this file only supplies what a browser tab
// would have — a menu bar, file pickers, downloads, and links that leave in the default browser —
// plus what a tab cannot: measuring the disk for the Disk tool (which never deletes), a capture
// panel on ⌃⌥Space and in the menu bar, due dates in Notification Center, and updating itself.
// The page's half is src/lib/mac.ts.
// ponytail: no Xcode project, `macos/build.sh` compiles this with swiftc.
import AppKit
import Carbon.HIToolbox
import CryptoKit
import UserNotifications
import WebKit

// `defaults write xyz.pyvno.stash url http://localhost:5173` points it at a dev server.
let home = URL(string: UserDefaults.standard.string(forKey: "url") ?? "https://stash.pyvno.xyz")!

@MainActor
final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
  WKScriptMessageHandlerWithReply, UNUserNotificationCenterDelegate, NSWindowDelegate, NSTextFieldDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var status: NSStatusItem!
  var panel: NSPanel!
  var field: NSTextField!

  func applicationDidFinishLaunching(_ note: Notification) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()   // persistent: localStorage and the session cookie survive a quit
    // its presence is also how the page knows it is in the app and offers the Disk tool
    config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "stash")
    web = WKWebView(frame: .zero, configuration: config)
    web.navigationDelegate = self
    web.uiDelegate = self
    web.allowsBackForwardNavigationGestures = true
    web.isInspectable = true
    // the page's own sheet colour behind it until it paints, so a dark launch does not flash white
    let sheet = NSColor(name: nil) { look in
      look.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        ? NSColor(srgbRed: 0x1a / 255, green: 0x1b / 255, blue: 0x1e / 255, alpha: 1) : .white
    }
    web.setValue(false, forKey: "drawsBackground")
    web.underPageBackgroundColor = sheet

    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Stash"
    window.backgroundColor = sheet
    window.isReleasedWhenClosed = false
    window.contentView = web
    window.center()
    window.setFrameAutosaveName("main")
    window.makeKeyAndOrderFront(nil)

    NSApp.mainMenu = menu()
    statusItem()
    hotkey()
    UNUserNotificationCenter.current().delegate = self
    web.load(URLRequest(url: home))
    Task { await update() }
    Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { _ in Task { @MainActor in await self.update() } }
  }

  // MARK: updates

  /// Installed over this copy and waiting for a restart, so a later check does not fetch it again.
  var updated: String?

  /// What the site serves (`mac.json`, written by build.sh) against this copy's version. A newer
  /// one is downloaded, checked against the key this app shipped with, and put in place of this
  /// bundle; the page offers the restart. A zip that does not verify is never unpacked.
  func update() async {
    let info = Bundle.main.infoDictionary ?? [:]
    guard updated == nil,
          let raw = (info["StashUpdateKey"] as? String).flatMap({ Data(base64Encoded: $0) }),
          let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) else { return }
    func get(_ path: String) async throws -> Data {
      let (data, res) = try await URLSession.shared.data(for: URLRequest(url: home.appending(path: path), cachePolicy: .reloadIgnoringLocalCacheData))
      guard (res as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
      return data
    }
    let fm = FileManager.default
    let tmp = fm.temporaryDirectory.appending(path: "stash-update-\(UUID().uuidString)")
    defer { try? fm.removeItem(at: tmp) }
    do {
      let served = try JSONDecoder().decode([String: String].self, from: try await get("mac.json"))
      let current = info["CFBundleShortVersionString"] as? String ?? "0"
      guard let version = served["version"], newer(version, than: current) else { return }
      let zip = try await get("Stash.zip")
      let sig = String(decoding: try await get("Stash.zip.sig"), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
      guard let signature = Data(base64Encoded: sig), key.isValidSignature(signature, for: zip) else { return }
      try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
      try zip.write(to: tmp.appending(path: "Stash.zip"))
      let unzip = try Process.run(URL(fileURLWithPath: "/usr/bin/ditto"),
                                  arguments: ["-x", "-k", tmp.appending(path: "Stash.zip").path, tmp.path])
      await Task.detached { unzip.waitUntilExit() }.value
      let fresh = tmp.appending(path: "Stash.app")
      // the version that counts is the one inside the signed app, not mac.json's word for it: an old
      // zip signed long ago must not roll this one back to whatever was wrong with it
      guard unzip.terminationStatus == 0, let bundle = Bundle(url: fresh),
            bundle.bundleIdentifier == Bundle.main.bundleIdentifier,
            let inside = bundle.infoDictionary?["CFBundleShortVersionString"] as? String,
            inside == version, newer(inside, than: current) else { return }
      do {
        _ = try fm.replaceItemAt(Bundle.main.bundleURL, withItemAt: fresh)
      } catch {
        // run from somewhere read-only — still in Downloads, so macOS moved it to a private copy
        send("stash:update-failed", version)
        return
      }
      updated = version
      send("stash:updated", version)
    } catch {
      return   // offline, or the server did not answer: the next check tries again
    }
  }

  /// 5.10.0 after 5.9.2: compared number by number, not as text.
  func newer(_ a: String, than b: String) -> Bool { a.compare(b, options: .numeric) == .orderedDescending }

  /// Quit, and open the same path again once this process is gone — which is now the new version.
  func relaunch() {
    let wait = Process()
    wait.executableURL = URL(fileURLWithPath: "/bin/sh")
    wait.arguments = ["-c", "while kill -0 $1 2>/dev/null; do sleep 0.2; done; open \"$0\"",
                      Bundle.main.bundleURL.path, String(ProcessInfo.processInfo.processIdentifier)]
    try? wait.run()
    NSApp.terminate(nil)
  }

  @objc func show() {
    window.makeKeyAndOrderFront(nil)
    NSApp.activate()
  }

  /// An event on the page's window (see src/lib/mac.ts). Arguments, not interpolation: a captured
  /// line is whatever was typed, quotes and all.
  func send(_ name: String, _ detail: String) {
    web.callAsyncJavaScript("dispatchEvent(new CustomEvent(name, { detail }))",
                           arguments: ["name": name, "detail": detail], in: nil, in: .page, completionHandler: nil)
  }

  // MARK: capture

  func statusItem() {
    status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    status.button?.image = NSImage(systemSymbolName: "tray.and.arrow.down", accessibilityDescription: "Stash")
    let m = NSMenu()
    let cap = NSMenuItem(title: "Capture…", action: #selector(capture), keyEquivalent: " ")
    cap.keyEquivalentModifierMask = [.control, .option]   // shown, not bound: the hotkey below is
    for i in [cap, NSMenuItem(title: "Open Stash", action: #selector(show), keyEquivalent: "")] {
      i.target = self
      m.addItem(i)
    }
    m.addItem(.separator())
    m.addItem(NSMenuItem(title: "Quit Stash", action: #selector(NSApplication.terminate(_:)), keyEquivalent: ""))
    status.menu = m
  }

  /// ⌃⌥Space from any app. Carbon's hot keys need no Accessibility permission, which an event tap would.
  /// ponytail: fixed chord; make it a setting if it ever collides with something.
  func hotkey() {
    var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
    InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
      MainActor.assumeIsolated { (NSApp.delegate as? App)?.capture() }   // delivered on the main thread
      return noErr
    }, 1, &spec, nil, nil)
    var ref: EventHotKeyRef?
    RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey),
                        EventHotKeyID(signature: OSType(0x5354_4153), id: 1), GetApplicationEventTarget(), 0, &ref)
  }

  /// A Spotlight-sized field over whatever you are in. Non-activating: typing into it leaves the app
  /// you came from in front, and Enter puts you straight back there.
  @objc func capture() {
    if panel == nil {
      panel = KeyPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 56),
                       styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
      panel.titleVisibility = .hidden
      panel.titlebarAppearsTransparent = true
      for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(b)?.isHidden = true }
      panel.level = .floating
      panel.hidesOnDeactivate = false
      panel.isMovableByWindowBackground = true
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
      panel.delegate = self
      field = NSTextField(frame: NSRect(x: 18, y: 12, width: 524, height: 30))
      field.font = .systemFont(ofSize: 20)
      field.isBordered = false
      field.drawsBackground = false
      field.focusRingType = .none
      field.placeholderString = "Capture to Stash: @project #tag tomorrow 9am"
      field.target = self
      field.action = #selector(captured)
      field.delegate = self
      panel.contentView?.addSubview(field)
    }
    field.stringValue = ""
    if let screen = NSScreen.main?.visibleFrame {   // upper third, where Spotlight sits
      panel.setFrameOrigin(NSPoint(x: screen.midX - 280, y: screen.minY + screen.height * 0.68))
    }
    panel.makeKeyAndOrderFront(nil)
    panel.makeFirstResponder(field)
  }

  @objc func captured() {
    let line = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    panel.orderOut(nil)
    if !line.isEmpty { send("stash:capture", line) }
  }

  // Esc, or clicking anywhere else, puts it away with nothing filed
  func control(_ control: NSControl, textView: NSTextView, doCommandBy sel: Selector) -> Bool {
    guard sel == #selector(NSResponder.cancelOperation(_:)) else { return false }
    panel.orderOut(nil)
    return true
  }

  func windowDidResignKey(_ note: Notification) {
    if (note.object as? NSWindow) === panel { panel.orderOut(nil) }
  }

  // MARK: notifications

  // up on screen even while Stash is the app in front
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                          willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
    [.banner, .sound]
  }

  // clicked: the window, on the row it was about
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
    let id = response.notification.request.identifier
    await MainActor.run {
      show()
      send("stash:open", id)
    }
  }

  /// The page's whole schedule, replacing whatever was pending: it sends it whenever it changes.
  func remind(_ list: [[String: Any]]) async {
    let center = UNUserNotificationCenter.current()
    center.removeAllPendingNotificationRequests()
    let requests = list.compactMap { r -> UNNotificationRequest? in
      guard let id = r["id"] as? String, let title = r["title"] as? String, let when = r["when"] as? Double else { return nil }
      let content = UNMutableNotificationContent()
      content.title = title
      content.body = r["body"] as? String ?? ""
      content.sound = .default
      let at = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: Date(timeIntervalSince1970: when / 1000))
      return UNNotificationRequest(identifier: id, content: content, trigger: UNCalendarNotificationTrigger(dateMatching: at, repeats: false))
    }
    // asked the first time there is something to say, not at launch
    guard !requests.isEmpty, (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
    for r in requests { try? await center.add(r) }
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

  /// The site could not be reached and nothing was cached to open instead — first launch offline,
  /// the server down, a captive portal. A blank window says nothing; this says what happened, and
  /// tries again by itself as well as on the button.
  func webView(_ web: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
    // only the network failing: a download, a redirect or a cancelled load ends here too, under
    // WebKit's own error domain or as a cancel, and must not swap the running app for this page
    let e = error as NSError
    guard e.domain == NSURLErrorDomain, e.code != NSURLErrorCancelled else { return }
    let target = home.absoluteString.replacingOccurrences(of: "'", with: "%27")
    let why = e.localizedDescription.replacingOccurrences(of: "<", with: "&lt;")
    web.loadHTMLString("""
      <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
      <style>
        :root { --bg: #fff; --fg: #17181b; --muted: #62656d; --line: #e6e6e2 }
        @media (prefers-color-scheme: dark) { :root { --bg: #1a1b1e; --fg: #edede9; --muted: #9a9da5; --line: #2a2c31 } }
        html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg);
          font: 14px/1.5 -apple-system, system-ui, sans-serif; -webkit-user-select: none }
        body { display: grid; place-items: center }
        main { max-width: 320px; text-align: center }
        h1 { font-size: 17px; font-weight: 600; margin: 0 0 4px }
        p { color: var(--muted); margin: 0 0 16px }
        button { font: inherit; color: var(--fg); background: transparent; border: 1px solid var(--line);
          border-radius: 8px; padding: 6px 14px; cursor: pointer }
      </style>
      <main>
        <h1>Can’t reach Stash</h1>
        <p>\(why)<br>Trying again by itself.</p>
        <button onclick="location.href='\(target)'">Try again</button>
      </main>
      <script>setTimeout(() => location.href = '\(target)', 15000)</script>
      """, baseURL: nil)
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

  // MARK: the page's requests

  // The disk ops are read-only on purpose: they measure, show a path in Finder, or copy text.
  // Removing anything is the script the page builds, which the user reads and runs in Terminal.
  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
    // the whole origin, not just the host: an http:// page or another port on the same name is not the app
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == home.scheme, origin.host == home.host,
          origin.port == (home.port ?? 0),
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
    case "remind":
      await remind(body["list"] as? [[String: Any]] ?? [])
      return (true, nil)
    case "relaunch":
      relaunch()
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
  func tell(_ what: String) { send("stash:menu", what) }

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

/// The capture panel has no title bar to click, and a borderless window will not take typing without this.
final class KeyPanel: NSPanel {
  override var canBecomeKey: Bool { true }
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
