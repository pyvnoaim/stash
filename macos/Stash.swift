// Stash for macOS: one window, one WKWebView on the deployed app. Everything the app is lives on
// the server and in this web view's own localStorage; this file only supplies what a browser tab
// would have — a menu bar, file pickers, downloads, and links that leave in the default browser —
// plus updating itself.
// The page's half is src/lib/mac.ts.
// ponytail: no Xcode project, `macos/build.sh` compiles this with swiftc.
import AppKit
import CryptoKit
import UserNotifications
import WebKit

// `defaults write xyz.pyvno.stash url http://localhost:5173` points it at a dev server.
let home = URL(string: UserDefaults.standard.string(forKey: "url") ?? "https://stash.pyvno.xyz")!

@MainActor
final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate,
  WKScriptMessageHandlerWithReply, NSWindowDelegate {
  var window: NSWindow!
  var web: WKWebView!
  var side: DragStrip!

  func applicationDidFinishLaunching(_ note: Notification) {
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .default()   // persistent: localStorage and the session cookie survive a quit
    // its presence is also how the page knows it is in the app
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
      styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
      backing: .buffered, defer: false)
    window.title = "Stash"
    /* No title bar: the page runs to the top edge and the three buttons sit in the sidebar's first
       row, beside the wordmark (the page makes room — see `mac` in src/lib/mac.ts). The window still
       moves by its top edge: a thin native strip over the page does what a title bar would. */
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    /* The buttons sit inset and lower, as in Notes or Mail, rather than tight in the corner of a
       28-point bar — placed by hand (`placeButtons`), not by an empty toolbar: with a toolbar on the
       window, Rectangle could no longer find it. */
    window.delegate = self
    // light or dark follows the page's own theme (the "theme" op from src/lib/mac.ts), not the Mac's
    window.backgroundColor = sheet
    window.isReleasedWhenClosed = false
    let frame = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800))   // the window's size, so the parts resize from it
    web.frame = frame.bounds
    web.autoresizingMask = [.width, .height]
    frame.addSubview(web)
    // the margin above the page, across the whole window
    let margin = DragStrip(frame: NSRect(x: 0, y: frame.bounds.height - 8, width: frame.bounds.width, height: 8))
    margin.autoresizingMask = [.width, .minYMargin]
    frame.addSubview(margin)
    // the sidebar's first row, beside the buttons — as wide as the page says the sidebar is ("chrome")
    side = DragStrip(frame: NSRect(x: 0, y: frame.bounds.height - DragStrip.height, width: 0, height: DragStrip.height))
    side.autoresizingMask = [.minYMargin]
    frame.addSubview(side)
    window.contentView = frame
    window.center()
    window.setFrameAutosaveName("main")
    window.makeKeyAndOrderFront(nil)
    placeButtons()
    watchButtons()

    NSApp.mainMenu = menu()
    // the system's own Window menu: Move & Resize, tiling, the open-window list
    NSApp.windowsMenu = NSApp.mainMenu?.items.last?.submenu
    /* Due-date reminders came out in 6.4.0, but what an older build handed macOS is still
       scheduled there and would fire for tasks long finished. Cleared on every launch; costs
       nothing when there is none. */
    let center = UNUserNotificationCenter.current()
    center.removeAllPendingNotificationRequests()
    center.removeAllDeliveredNotifications()
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

  /// An event on the page's window (see src/lib/mac.ts). Arguments, not interpolation, so a detail
  /// cannot break out of the string it is in.
  func send(_ name: String, _ detail: String) {
    web.callAsyncJavaScript("dispatchEvent(new CustomEvent(name, { detail }))",
                           arguments: ["name": name, "detail": detail], in: nil, in: .page, completionHandler: nil)
  }

  /// Where the three buttons go: centred in a 52-point band, 20 points in. macOS lays them out again
  /// whenever it likes — on every resize, leaving full screen, and once more after the window first
  /// appears, which is why they sat in the corner at launch until the window was dragged. So each
  /// button is watched, and put back the moment macOS moves it (`watchButtons`).
  func placeButtons() {
    // in full screen the title area is macOS's own, drawn apart from the window: leave it be
    guard !window.styleMask.contains(.fullScreen),
          let close = window.standardWindowButton(.closeButton), let band = close.superview?.superview else { return }
    var f = band.frame
    f.size.height = DragStrip.height
    f.origin.y = window.frame.height - DragStrip.height
    band.frame = f
    for (i, kind) in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].enumerated() {
      guard let b = window.standardWindowButton(kind) else { continue }
      b.setFrameOrigin(NSPoint(x: 20 + CGFloat(i) * 20, y: (DragStrip.height - b.frame.height) / 2))
    }
  }
  func watchButtons() {
    /* The band they sit in, first: a moment after launch macOS shrinks it back to its own 32 points
       without touching the buttons, which leaves them pressed against the top — measured, not
       guessed: the buttons stayed at (20, 19) while the band went from 52 to 32. */
    if let band = window.standardWindowButton(.closeButton)?.superview?.superview {
      band.postsFrameChangedNotifications = true
      NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: band, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, band.frame.height != DragStrip.height else { return }
          self.placeButtons()
        }
      }
    }
    for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
      guard let b = window.standardWindowButton(kind) else { continue }
      b.postsFrameChangedNotifications = true
      NotificationCenter.default.addObserver(forName: NSView.frameDidChangeNotification, object: b, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated {
          // only when it is not where it belongs — the band shrunk back, or the button moved —
          // or placing it would set this off again for ever
          guard let self else { return }
          let at = NSPoint(x: 20 + CGFloat(kind.rawValue) * 20, y: (DragStrip.height - b.frame.height) / 2)
          if b.frame.origin != at || b.superview?.superview?.frame.height != DragStrip.height { self.placeButtons() }
        }
      }
    }
  }
  func windowDidResize(_ note: Notification) { if (note.object as? NSWindow) === window { placeButtons() } }
  func windowDidExitFullScreen(_ note: Notification) { if (note.object as? NSWindow) === window { placeButtons() } }
  func windowDidBecomeKey(_ note: Notification) { if (note.object as? NSWindow) === window { placeButtons() } }

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

  /// nil under the page's `auto`: the window, and so the web view's prefers-color-scheme, follow the Mac
  static func appearance(_ dark: Bool?) -> NSAppearance? {
    dark.flatMap { NSAppearance(named: $0 ? .darkAqua : .aqua) }
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

  func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) async -> (Any?, String?) {
    // the whole origin, not just the host: an http:// page or another port on the same name is not the app
    let origin = message.frameInfo.securityOrigin
    guard message.frameInfo.isMainFrame, origin.protocol == home.scheme, origin.host == home.host,
          origin.port == (home.port ?? 0),
          let body = message.body as? [String: Any] else { return (nil, "refused") }
    switch body["op"] as? String {
    case "chrome":
      // how wide the sidebar is now (0 when it is folded away), for the strip that drags the window
      let w = CGFloat(body["sidebar"] as? Double ?? 0)
      side.frame = NSRect(x: 0, y: side.superview!.bounds.height - DragStrip.height, width: w, height: DragStrip.height)
      return (true, nil)
    case "theme":
      // the page's light or dark, for the window's own chrome: title bar, traffic lights, menus
      window.appearance = Self.appearance(body["dark"] as? Bool)
      return (true, nil)
    case "relaunch":
      relaunch()
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

/// Where a title bar would be: drag the window by it, double-click to zoom it, as the system would.
/// Over the page, which keeps nothing clickable beneath one — the sidebar's first row, and the margin
/// above the sheet. `height` is the band the window's buttons are centred in (`placeButtons`).
final class DragStrip: NSView {
  static let height: CGFloat = 52
  override func mouseDown(with event: NSEvent) {
    if event.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: event) }
  }
}

MainActor.assumeIsolated {
  let delegate = App()
  NSApplication.shared.delegate = delegate
  NSApplication.shared.setActivationPolicy(.regular)
  NSApplication.shared.run()
}
