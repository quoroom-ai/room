import Cocoa

class AppDelegate: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!
    let port: Int
    let url: String
    let binPath: String
    let logFile: String

    var iconAnimTimer: Timer?
    var iconFilled = false

    override init() {
        let envPort = ProcessInfo.processInfo.environment["QUOROOM_PORT"]
        self.port = Int(envPort ?? "") ?? 3700
        self.url = "http://localhost:\(port)"

        let systemBin = "/usr/local/lib/quoroom/bin/quoroom"
        let homeBin = "\(NSHomeDirectory())/usr/local/lib/quoroom/bin/quoroom"
        self.binPath = FileManager.default.isExecutableFile(atPath: systemBin) ? systemBin : homeBin

        let logDir = "\(NSHomeDirectory())/Library/Logs/Quoroom"
        try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
        self.logFile = "\(logDir)/server.log"

        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Re-launch guard: if another instance is already running, just open dashboard and exit.
        let myBundleId = Bundle.main.bundleIdentifier ?? "ai.quoroom.server-launcher"
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: myBundleId)
        if running.count > 1 {
            NSWorkspace.shared.open(URL(string: url)!)
            NSApp.terminate(nil)
            return
        }

        // Create menu bar status item.
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            if #available(macOS 11.0, *) {
                button.image = NSImage(systemSymbolName: "hexagon",
                                       accessibilityDescription: "Quoroom")
            } else {
                button.title = "Q"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Dashboard",
                                action: #selector(openDashboard), keyEquivalent: "o"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Restart Server",
                                action: #selector(restartServer), keyEquivalent: "r"))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit Quoroom",
                                action: #selector(quitApp), keyEquivalent: "q"))
        statusItem.menu = menu

        // Start server if not already running, then open browser.
        if !isServerHealthy() {
            startServer()
        }
        pollHealthThenOpen()
    }

    // MARK: - Menu Bar Icon Animation

    func startIconAnimation() {
        stopIconAnimation()
        iconAnimTimer = Timer.scheduledTimer(withTimeInterval: 0.6, repeats: true) { [weak self] _ in
            guard let self = self, let button = self.statusItem.button else { return }
            self.iconFilled.toggle()
            if #available(macOS 11.0, *) {
                let name = self.iconFilled ? "hexagon.fill" : "hexagon"
                button.image = NSImage(systemSymbolName: name,
                                       accessibilityDescription: "Quoroom")
            }
        }
    }

    func stopIconAnimation() {
        iconAnimTimer?.invalidate()
        iconAnimTimer = nil
        iconFilled = false
        if let button = statusItem?.button {
            if #available(macOS 11.0, *) {
                button.image = NSImage(systemSymbolName: "hexagon",
                                       accessibilityDescription: "Quoroom")
            }
        }
    }

    // MARK: - Health Check

    /// Check that the server is fully ready — API responds AND the UI page is served.
    func isServerHealthy() -> Bool {
        return checkURL("\(url)/api/auth/handshake", minBytes: 10)
            && checkURL(url, minBytes: 500)
    }

    private func checkURL(_ urlString: String, minBytes: Int) -> Bool {
        guard let checkURL = URL(string: urlString) else { return false }
        var request = URLRequest(url: checkURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 2.0

        let semaphore = DispatchSemaphore(value: 0)
        var ok = false
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            if let http = response as? HTTPURLResponse, http.statusCode == 200,
               let data = data, data.count >= minBytes {
                ok = true
            }
            semaphore.signal()
        }
        task.resume()
        semaphore.wait()
        return ok
    }

    func pollHealthThenOpen() {
        DispatchQueue.main.async { self.startIconAnimation() }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            // Phase 1: wait for server to respond (up to 20s).
            for _ in 1...20 {
                if isServerHealthy() { break }
                Thread.sleep(forTimeInterval: 1.0)
            }

            // Phase 2: 10-second wait for UI to fully load.
            Thread.sleep(forTimeInterval: 10.0)

            DispatchQueue.main.async {
                self.stopIconAnimation()
                self.openBrowser()
            }
        }
    }

    // MARK: - Server Lifecycle

    func startServer() {
        var env = ProcessInfo.processInfo.environment
        env["QUOROOM_NO_AUTO_OPEN"] = "1"

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binPath)
        process.arguments = ["serve", "--port", "\(port)"]
        process.environment = env

        // Redirect stdout/stderr to log file.
        FileManager.default.createFile(atPath: logFile, contents: nil)
        if let handle = FileHandle(forWritingAtPath: logFile) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
        }

        do {
            try process.run()
        } catch {
            NSLog("Quoroom: failed to start server: \(error)")
        }
    }

    func pidsOnPort() -> [Int32] {
        let pipe = Pipe()
        let lsof = Process()
        lsof.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        lsof.arguments = ["-ti", ":\(port)"]
        lsof.standardOutput = pipe
        lsof.standardError = FileHandle.nullDevice

        do {
            try lsof.run()
            lsof.waitUntilExit()
        } catch { return [] }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [] }

        return output.split(separator: "\n").compactMap {
            Int32($0.trimmingCharacters(in: .whitespaces))
        }
    }

    func processTreePids(rootPid: Int32) -> [Int32] {
        let pipe = Pipe()
        let ps = Process()
        ps.executableURL = URL(fileURLWithPath: "/bin/ps")
        ps.arguments = ["-axo", "pid=,ppid="]
        ps.standardOutput = pipe
        ps.standardError = FileHandle.nullDevice

        do {
            try ps.run()
            ps.waitUntilExit()
        } catch { return [rootPid] }

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let output = String(data: data, encoding: .utf8) else { return [rootPid] }

        var byParent: [Int32: [Int32]] = [:]
        for rawLine in output.split(separator: "\n") {
            let parts = rawLine
                .split(whereSeparator: { $0 == " " || $0 == "\t" })
                .map(String.init)
            guard parts.count >= 2,
                  let pid = Int32(parts[0]),
                  let ppid = Int32(parts[1]) else { continue }
            byParent[ppid, default: []].append(pid)
        }

        var result = Set<Int32>()
        var stack: [Int32] = [rootPid]
        while let current = stack.popLast() {
            if result.contains(current) { continue }
            result.insert(current)
            let children = byParent[current] ?? []
            for child in children where !result.contains(child) {
                stack.append(child)
            }
        }
        return Array(result)
    }

    func pidExists(_ pid: Int32) -> Bool {
        if kill(pid, 0) == 0 { return true }
        return errno == EPERM
    }

    func killServerOnPort() {
        let roots = pidsOnPort()
        guard !roots.isEmpty else { return }

        let selfPid = getpid()
        var allPids = Set<Int32>()
        for root in roots {
            for pid in processTreePids(rootPid: root) where pid != selfPid && pid > 1 {
                allPids.insert(pid)
            }
        }
        guard !allPids.isEmpty else { return }

        let targets = allPids.sorted()

        // Graceful shutdown.
        for pid in targets { kill(pid, SIGTERM) }
        Thread.sleep(forTimeInterval: 1.0)

        // Force-kill anything still lingering.
        var hadRemaining = false
        for pid in targets where pidExists(pid) {
            hadRemaining = true
            kill(pid, SIGKILL)
        }
        if hadRemaining {
            Thread.sleep(forTimeInterval: 0.5)
        }
    }

    // MARK: - Menu Actions

    @objc func openDashboard() {
        if !isServerHealthy() {
            startServer()
        }
        pollHealthThenOpen()
    }

    @objc func restartServer() {
        DispatchQueue.main.async { self.startIconAnimation() }
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            killServerOnPort()
            DispatchQueue.main.async {
                self.startServer()
                self.pollHealthThenOpen()
            }
        }
    }

    @objc func quitApp() {
        DispatchQueue.global(qos: .userInitiated).async { [self] in
            killServerOnPort()
            DispatchQueue.main.async { NSApp.terminate(nil) }
        }
    }

    func openBrowser() {
        NSWorkspace.shared.open(URL(string: url)!)
    }
}

// Entry point — no storyboards, no XIBs.
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
