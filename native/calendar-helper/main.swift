// IncarnaMind's Mac calendar helper (#190): reads the Calendar app's calendars and events through
// EventKit, read-only, and prints one line of JSON. Only `request` may show the system's prompt.
import EventKit
import Foundation

// Made only by the commands that need it: `access` reads the status alone.
var opened: EKEventStore?
func store() -> EKEventStore {
  if let existing = opened { return existing }
  let made = EKEventStore()
  opened = made
  return made
}
let isoFormatter = ISO8601DateFormatter()
isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func emit(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: []),
    let line = String(data: data, encoding: .utf8)
  else {
    FileHandle.standardError.write("The answer couldn't be written as JSON.\n".data(using: .utf8)!)
    exit(1)
  }
  print(line)
}

func fail(_ message: String, code: Int32 = 1) -> Never {
  emit(["error": message])
  exit(code)
}

func access() -> String {
  let status = EKEventStore.authorizationStatus(for: .event)
  if #available(macOS 14.0, *) {
    switch status {
    case .fullAccess: return "allowed"
    case .writeOnly, .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not-asked"
    @unknown default: return "denied"
    }
  }
  switch status.rawValue {
  case EKAuthorizationStatus.authorized.rawValue: return "allowed"
  case EKAuthorizationStatus.restricted.rawValue: return "restricted"
  case EKAuthorizationStatus.notDetermined.rawValue: return "not-asked"
  default: return "denied"
  }
}

func requestAccess() -> String {
  let done = DispatchSemaphore(value: 0)
  let finished: EKEventStoreRequestAccessCompletionHandler = { _, _ in done.signal() }
  if #available(macOS 14.0, *) {
    store().requestFullAccessToEvents(completion: finished)
  } else {
    store().requestAccess(to: .event, completion: finished)
  }
  done.wait()
  return access()
}

func requireAccess() {
  if access() != "allowed" { fail("not-allowed", code: 3) }
}

func calendarKind(_ calendar: EKCalendar) -> String {
  switch calendar.type {
  case .local: return "local"
  case .calDAV: return "caldav"
  case .exchange: return "exchange"
  case .subscription: return "subscription"
  case .birthday: return "birthday"
  @unknown default: return "other"
  }
}

func emailOf(_ url: URL) -> Any {
  guard url.scheme?.lowercased() == "mailto" else { return NSNull() }
  let address = url.absoluteString.dropFirst("mailto:".count)
  let decoded = address.removingPercentEncoding ?? String(address)
  return decoded.isEmpty ? NSNull() : decoded
}

func statusOf(_ participant: EKParticipant) -> String {
  switch participant.participantStatus {
  case .accepted: return "accepted"
  case .declined: return "declined"
  case .tentative: return "tentative"
  case .pending: return "pending"
  default: return "unknown"
  }
}

func person(_ participant: EKParticipant) -> [String: Any] {
  return [
    "name": participant.name ?? NSNull(),
    "email": emailOf(participant.url),
    "self": participant.isCurrentUser,
    "status": statusOf(participant),
  ]
}

func eventStatus(_ event: EKEvent) -> String {
  switch event.status {
  case .confirmed: return "confirmed"
  case .tentative: return "tentative"
  case .canceled: return "cancelled"
  default: return "none"
  }
}

func eventJSON(_ event: EKEvent) -> [String: Any] {
  let recurring = event.hasRecurrenceRules || event.isDetached
  return [
    "calendarId": event.calendar.calendarIdentifier,
    "id": event.eventIdentifier ?? event.calendarItemIdentifier,
    "externalId": event.calendarItemExternalIdentifier ?? NSNull(),
    "occurrence": recurring ? isoFormatter.string(from: event.occurrenceDate) : NSNull(),
    "title": event.title ?? "",
    "start": isoFormatter.string(from: event.startDate),
    "end": isoFormatter.string(from: event.endDate),
    "allDay": event.isAllDay,
    "status": eventStatus(event),
    "attendees": (event.attendees ?? []).map(person),
    "organizer": event.organizer.map(person) ?? NSNull(),
    "url": event.url?.absoluteString ?? NSNull(),
    "location": event.location ?? NSNull(),
    "notes": event.notes ?? NSNull(),
  ]
}

func dateArgument(_ value: String?, _ name: String) -> Date {
  guard let value else { fail("\(name) is missing") }
  let plain = ISO8601DateFormatter()
  guard let date = isoFormatter.date(from: value) ?? plain.date(from: value) else {
    fail("\(name) isn't an ISO 8601 time: \(value)")
  }
  return date
}

func events(_ arguments: ArraySlice<String>) {
  var from: String?
  var to: String?
  var ids: [String] = []
  var rest = arguments.makeIterator()
  while let argument = rest.next() {
    switch argument {
    case "--from": from = rest.next()
    case "--to": to = rest.next()
    case "--calendar": if let id = rest.next() { ids.append(id) }
    default: fail("Unknown argument \(argument)")
    }
  }
  let start = dateArgument(from, "--from")
  let end = dateArgument(to, "--to")
  requireAccess()
  let calendars = store().calendars(for: .event).filter { ids.contains($0.calendarIdentifier) }
  if calendars.isEmpty {
    emit(["events": []])
    return
  }
  let predicate = store().predicateForEvents(withStart: start, end: end, calendars: calendars)
  emit(["events": store().events(matching: predicate).map(eventJSON)])
}

let arguments = CommandLine.arguments.dropFirst()
switch arguments.first {
case "access":
  emit(["access": access()])
case "request":
  emit(["access": requestAccess()])
case "calendars":
  requireAccess()
  emit([
    "calendars": store().calendars(for: .event).map { calendar in
      [
        "id": calendar.calendarIdentifier,
        "title": calendar.title,
        "source": calendar.source?.title ?? "",
        "kind": calendarKind(calendar),
      ]
    }
  ])
case "events":
  events(arguments.dropFirst())
default:
  fail("Unknown command: \(arguments.first ?? "none"). Use access, request, calendars or events.")
}
