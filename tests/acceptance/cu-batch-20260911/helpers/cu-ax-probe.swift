// Independent OS oracle for the CU-* suite: the text a window really holds, read through the
// Accessibility API. This belongs to macOS, not to the product — the product is never asked what it
// thinks it typed.
//
// Usage:
//   cu-ax-probe read  <pid> [windowTitle]   -> {"trusted":true,"title":…,"text":…,"selection":[loc,len]}
//   cu-ax-probe reset <pid> [windowTitle]   -> {"trusted":true,"title":…,"text":"","setStatus":0}
//
// `reset` exists only to prepare the suite's own disposable document (an empty document is the
// starting state every effect case assumes); it is fixture preparation, not an assertion.
//
// Every reply is one JSON object on stdout, exit code 0. Failure shapes:
//   {"trusted":false,"error":"accessibility-not-trusted"}   the calling process lacks 辅助功能 permission
//   {"error":"no-windows-attribute" | "no-text-element" | "window-not-found" | "set-failed"}
// The suite turns any of those into ENVIRONMENT_BLOCKED — it never ticks a permission box itself.
import ApplicationServices
import Foundation

func emit(_ object: [String: Any]) -> Never {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var value: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
  attribute(element, name) as? String
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func findTextElement(_ element: AXUIElement, depth: Int = 0) -> AXUIElement? {
  if depth > 12 { return nil }
  let role = stringAttribute(element, kAXRoleAttribute) ?? ""
  if role == kAXTextAreaRole || role == kAXTextFieldRole { return element }
  for child in children(element) {
    if let found = findTextElement(child, depth: depth + 1) { return found }
  }
  return nil
}

let arguments = CommandLine.arguments
let mode = arguments.count > 1 ? arguments[1] : ""
guard arguments.count > 2, let pid = pid_t(arguments[2]) else { emit(["error": "usage: cu-ax-probe read|reset <pid> [windowTitle]"]) }
let wantedTitle = arguments.count > 3 ? arguments[3] : nil

guard AXIsProcessTrusted() else { emit(["trusted": false, "error": "accessibility-not-trusted"]) }

let app = AXUIElementCreateApplication(pid)
guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] else {
  emit(["trusted": true, "error": "no-windows-attribute"])
}

var seenTitles: [String] = []
for window in windows {
  let title = stringAttribute(window, kAXTitleAttribute) ?? ""
  seenTitles.append(title)
  if let wantedTitle, title != wantedTitle { continue }
  guard let area = findTextElement(window) else { emit(["trusted": true, "error": "no-text-element", "title": title]) }

  if mode == "reset" {
    let status = AXUIElementSetAttributeValue(area, kAXValueAttribute as CFString, "" as CFTypeRef)
    usleep(200_000)
    emit(["trusted": true, "title": title, "text": stringAttribute(area, kAXValueAttribute) as Any, "setStatus": status.rawValue])
  }

  var selection: [Int] = []
  if let range = attribute(area, kAXSelectedTextRangeAttribute), CFGetTypeID(range) == AXValueGetTypeID() {
    var cfRange = CFRange()
    if AXValueGetValue(range as! AXValue, .cfRange, &cfRange) { selection = [cfRange.location, cfRange.length] }
  }
  emit([
    "trusted": true,
    "title": title,
    "text": stringAttribute(area, kAXValueAttribute) as Any,
    "selection": selection,
  ])
}

emit(["trusted": true, "error": "window-not-found", "titles": seenTitles])
