import Cocoa
import WebKit

/// Prong desktop shell: a native macOS window hosting the web build, with the bundled git engine
/// (Node + compiled server) started as a child process. Native services (folder picker, reveal,
/// open in terminal) are exposed to the UI through a WKScriptMessageHandler bridge.
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?
    var port = 8790
    let resources = Bundle.main.resourceURL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        port = freePort(preferred: 8790)
        startServer()
        makeWindow()
        waitForServer(attempts: 0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    /// Back in Prong (from a terminal, an IDE): the page re-reads the open repository, as Fork does.
    func applicationDidBecomeActive(_ notification: Notification) {
        webView?.evaluateJavaScript("window.dispatchEvent(new Event('prong-activate'))", completionHandler: nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    // MARK: engine

    func startServer() {
        let node = resources.appendingPathComponent("bin/node").path
        let entry = resources.appendingPathComponent("server/src/index.js").path
        let web = resources.appendingPathComponent("web").path
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [entry]
        var env = ProcessInfo.processInfo.environment
        env["PRONG_PORT"] = String(port)
        env["PRONG_WEB_DIR"] = web
        // a GUI app inherits a minimal PATH; make sure git from Xcode CLT / Homebrew is found
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:" + (env["PATH"] ?? "")
        p.environment = env
        let log = FileHandle(forWritingAtPath: logPath()) ?? FileHandle.standardError
        p.standardOutput = log
        p.standardError = log
        p.terminationHandler = { proc in
            NSLog("[prong] engine exited with status \(proc.terminationStatus)")
        }
        do {
            try p.run()
            server = p
        } catch {
            NSLog("[prong] failed to start engine: \(error)")
        }
    }

    func logPath() -> String {
        let dir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".prong", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("engine.log")
        if !FileManager.default.fileExists(atPath: file.path) { FileManager.default.createFile(atPath: file.path, contents: nil) }
        return file.path
    }

    func freePort(preferred: Int) -> Int {
        // try the preferred port, then a few above it
        for candidate in preferred..<(preferred + 20) {
            let sock = socket(AF_INET, SOCK_STREAM, 0)
            if sock < 0 { continue }
            var addr = sockaddr_in()
            addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            addr.sin_family = sa_family_t(AF_INET)
            addr.sin_port = in_port_t(candidate).bigEndian
            addr.sin_addr.s_addr = inet_addr("127.0.0.1")
            let ok = withUnsafePointer(to: &addr) { ptr -> Bool in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
            }
            close(sock)
            if ok { return candidate }
        }
        return preferred
    }

    func waitForServer(attempts: Int) {
        let url = URL(string: "http://127.0.0.1:\(port)/api/health")!
        URLSession.shared.dataTask(with: url) { data, _, _ in
            DispatchQueue.main.async {
                if data != nil {
                    self.webView.load(URLRequest(url: URL(string: "http://127.0.0.1:\(self.port)/")!))
                } else if attempts < 100 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.waitForServer(attempts: attempts + 1) }
                } else {
                    self.webView.loadHTMLString("<body style='background:#0f1113;color:#d9dee3;font:14px JetBrains Mono,Menlo,monospace;padding:40px'>Prong: the git engine did not start. See ~/.prong/engine.log</body>", baseURL: nil)
                }
            }
        }.resume()
    }

    // MARK: window

    func makeWindow() {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        config.userContentController.add(self, name: "prong")
        // tell the UI it runs inside the desktop shell
        let boot = WKUserScript(source: """
            window.__PRONG_DESKTOP__ = { version: '0.1.0', platform: 'macos' };
            (function(){
              const send = (text) => { try { window.webkit.messageHandlers.prong.postMessage({ cmd: 'log', text: String(text).slice(0, 600) }); } catch (e) {} };
              window.addEventListener('error', (e) => send('error: ' + e.message + ' @ ' + (e.filename || '') + ':' + e.lineno));
              window.addEventListener('unhandledrejection', (e) => send('unhandled: ' + (e.reason && (e.reason.stack || e.reason.message) || e.reason)));
              const ce = console.error; console.error = function() { send('console.error: ' + Array.from(arguments).map(String).join(' ')); ce.apply(console, arguments); };
              window.addEventListener('load', () => { try { getSelection().removeAllRanges(); } catch (e) {} });
              window.addEventListener('load', () => setTimeout(() => { const r = document.body.firstElementChild && document.body.firstElementChild.getBoundingClientRect(); send('dom: ' + document.body.children.length + ' children, text ' + document.body.innerText.length + ' chars, win ' + innerWidth + 'x' + innerHeight + ', fonts ' + (document.fonts ? document.fonts.status + '/' + document.fonts.size : 'n/a') + ', root ' + (r ? Math.round(r.width) + 'x' + Math.round(r.height) : 'none') + ', ua ' + navigator.userAgent.slice(-40)); }, 3000));
            })();
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true)
        config.userContentController.addUserScript(boot)
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        let frame = NSRect(x: 0, y: 0, width: 1360, height: 860)
        window = NSWindow(contentRect: frame, styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Prong"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .visible
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(red: 0.059, green: 0.067, blue: 0.075, alpha: 1)
        window.minSize = NSSize(width: 900, height: 560)
        window.contentView = webView
        window.delegate = self
        window.setFrameAutosaveName("ProngMain")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func buildMenu() {
        let main = NSMenu()
        let app = NSMenuItem(); main.addItem(app)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Prong", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Prong", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit Prong", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        app.submenu = appMenu

        let edit = NSMenuItem(); main.addItem(edit)
        let editMenu = NSMenu(title: "Edit")
        // ⌘Z: text editing inside a field, otherwise Prong's Undo of the last action (the page decides)
        editMenu.addItem(withTitle: "Undo", action: #selector(appUndo), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.submenu = editMenu

        let view = NSMenuItem(); main.addItem(view)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Engine Log", action: #selector(openLog), keyEquivalent: "")
        view.submenu = viewMenu

        let win = NSMenuItem(); main.addItem(win)
        let winMenu = NSMenu(title: "Window")
        winMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        win.submenu = winMenu
        NSApp.mainMenu = main
    }

    @objc func reload() { webView.reload() }
    @objc func appUndo() {
        webView?.evaluateJavaScript("window.__prongUndo ? window.__prongUndo() : document.execCommand('undo')", completionHandler: nil)
    }
    @objc func openLog() { NSWorkspace.shared.open(URL(fileURLWithPath: logPath())) }

    // MARK: bridge  (window.webkit.messageHandlers.prong.postMessage({id, cmd, ...}))

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else { return }
        let id = body["id"] as? Int ?? 0
        switch cmd {
        case "pickFolder":
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true
            panel.canChooseFiles = false
            panel.allowsMultipleSelection = false
            panel.canCreateDirectories = true
            panel.prompt = body["prompt"] as? String ?? "Choose"
            panel.message = body["message"] as? String ?? "Choose a folder"
            panel.beginSheetModal(for: window) { resp in
                let path = resp == .OK ? panel.url?.path : nil
                self.reply(id: id, result: path)
            }
        case "reveal":
            if let p = body["path"] as? String { NSWorkspace.shared.selectFile(p, inFileViewerRootedAtPath: p) }
            reply(id: id, result: true)
        case "openTerminal":
            if let p = body["path"] as? String {
                let script = "tell application \"Terminal\" to do script \"cd \" & quoted form of \"\(p)\"\ntell application \"Terminal\" to activate"
                NSAppleScript(source: script)?.executeAndReturnError(nil)
            }
            reply(id: id, result: true)
        case "openExternal":
            if let s = body["url"] as? String, let u = URL(string: s) { NSWorkspace.shared.open(u) }
            reply(id: id, result: true)
        case "setTitle":
            window.title = body["title"] as? String ?? "Prong"
            reply(id: id, result: true)
        case "log":
            appendLog("js " + (body["text"] as? String ?? ""))
        default:
            reply(id: id, result: nil)
        }
    }

    func reply(id: Int, result: Any?) {
        var json = "null"
        if let r = result {
            if let s = r as? String, let data = try? JSONSerialization.data(withJSONObject: [s]), let arr = String(data: data, encoding: .utf8) {
                json = String(arr.dropFirst().dropLast())
            } else if let b = r as? Bool { json = b ? "true" : "false" }
        }
        webView.evaluateJavaScript("window.__prongReply && window.__prongReply(\(id), \(json));", completionHandler: nil)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        appendLog("navigation failed: \(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        appendLog("navigation error: \(error.localizedDescription)")
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        appendLog("ui loaded: \(webView.url?.absoluteString ?? "?")")
    }
    func appendLog(_ line: String) {
        if let h = FileHandle(forWritingAtPath: logPath()) {
            h.seekToEndOfFile()
            h.write(("[shell] " + line + "\n").data(using: .utf8)!)
            h.closeFile()
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // external links open in the default browser
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", host != "localhost", action.navigationType == .linkActivated {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
