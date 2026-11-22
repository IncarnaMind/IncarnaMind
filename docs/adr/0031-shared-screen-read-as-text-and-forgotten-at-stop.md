# The shared screen: one window, read as text on this computer, forgotten when the Meeting stops

ADR-0015 says no screen is captured: the meeting capture window asks for a display stream only because Chromium won't grant the computer's sound without one, and stops its video at once. During a call, though, people share slides and spreadsheets, and the User wants to ask about them: "What was the margin on the slide they just showed?" (#834). This amends ADR-0015: a Meeting may now read one window, which the User chooses in that Meeting, as text, for Answers during the call, and keeps nothing of it after the Meeting stops.

## What is captured

- **One window, chosen in each Meeting.** While a Meeting records, the meeting bar asks "Will someone share their screen?" (a line, not a dialog, until it is answered; Settings › Meetings turns the question off). Nothing is captured until the User chooses a window, and the choice isn't carried to the next Meeting.
- **IncarnaMind's own picker.** Choose window… lists the open windows with a picture of each (`desktopCapturer`, windows only), without IncarnaMind's own. The system's picker (ScreenCaptureKit's, through `useSystemPicker`) exists only on macOS 15 and later, so it isn't used.
- **Never a whole screen.** The display request is answered with the chosen window; a stream whose `displaySurface` is a monitor is stopped at once and the bar says so.
- **Video only, slowly.** The chosen window is a second display stream in the meeting capture window (ADR-0015), without audio, at no more than 2 frames a second. Pause stops it; Resume reads the same window again.

## The permission

- **macOS needs Screen Recording.** Capturing a window needs the "Screen & System Audio Recording" permission, stronger than the "System Audio Recording Only" that ADR-0015 chose for meetings on macOS 14.2 and later, and macOS 15 asks the User to confirm it again from time to time. So the first Choose window… says in the bar, before macOS asks, that macOS will ask to let IncarnaMind record the screen, that only the chosen window is read and that nothing is kept. Listing the windows asks.
- **Refused, the meeting goes on.** Without the permission the bar says so with Open System Settings (the same pane as the computer's sound), and the Meeting records as before, without the screen.
- **Windows asks for nothing.** Linux lists windows as X11 gives them; under Wayland the desktop portal shows its own dialog.

## Where it lives: memory only

- **Sampled once a second.** The capture window draws each sample as a small grey thumbnail and sends only that. The core compares thumbnails (`src/core/meetings/screenChanges.ts`): a picture that changed, and then stayed still for about 1.5 s (screen-share video sharpens once the image settles), is read; parts that keep moving, such as a video tile or a cursor, don't count as a change.
- **Read on this computer, twice.** The core asks the capture window for the settled frame, in grey for reading and in colour for an on-demand preview, reads it with the built-in recogniser (PP-OCRv5 in its utility process, ADR-0011's scans, #397), then reads the next frame a second later. A figure the two readings disagree on, or that the recogniser was unsure of, is marked unsure. Lines keep their boxes, so a table reads row by row and a slide's columns don't interleave (the scan reader's reading order).
- **Kept by the Meeting, in the core's memory.** Each read screen is its time, its text, its unsure figures, a preview, and the Library Passages its text matches (the local keyword search). Previews share a 32 MiB memory limit. On the first request for a preview or a visual question, the selected frame is encoded at 1,280 pixels on its longest side and JPEG quality 80. It stays in memory until evicted or the Meeting stops.

## What leaves, and when

- **Text first, when the User asks.** The current screen and up to two relevant screens from the selected window go with an in-call Question as locally recognised text. Where the Question points to a picture, the current window has little usable text, or its figures are uncertain, the selected model may also receive one small picture. “Look at the screen” explicitly asks again. Of the one-click Call Help buttons, only “Answer their question” can send a picture of a mostly visual frame. The app checks model capabilities, the spending cap and the meeting's picture allowance (30 by default). The Answer shows whether it used a picture. An estimate read only from a picture has a Citation whose value cannot be checked against text.
- **The Library first.** Where a screen's text matches a page of a Document the User has, that page goes with it, and the Answer can cite it too. That Citation is checkable and stays after the Meeting.

## Deleted at Stop

- **Everything from the screen.** Stopping the Meeting (or deleting its Mind, or quitting) stops the stream and drops every frame, every recognised text and every match. The after-the-call fill-in and the write-up read the Transcript only.
- **Screen Citations keep no quote.** Unlike every other Citation, a screen Citation is stored with its time and an empty quote: its check was made against the screen when the Answer was written. While the Meeting records, its card shows the frame from memory; afterwards it says "On the shared screen at 14:05 · deleted after the meeting", with nothing to open. The Answer's own words stay, as any Answer's do.

## Considered options

- **The system's window picker.** Rejected for now: it exists only on macOS 15 and later, and one picker everywhere is one way to learn. It could replace IncarnaMind's on those systems later, behind the same adapter.
- **Streaming the screen to a realtime video model** (Gemini Live, OpenAI Realtime). Rejected: one provider's key only, the whole call's screen sent away, and Answers with no quote to check.
- **Meeting bots and platform APIs.** Rejected: a bot is seen by everyone, costs by the hour, and doesn't reach 腾讯会议 or Teams on the desktop.
- **The system's own text recognition** (Vision on macOS, Windows.Media.Ocr). Rejected: on #484's scans, 1.1% and 8.6% of characters wrong against PP-OCRv5's 0.4%, and a different reader on each system. PP-OCRv5 is already downloaded for scans and reads English and Chinese.
- **Reading at the Question.** Rejected: OCR then costs the User a second or more on every Question, and the frame may already have changed.
- **Keeping the screen's text after the Meeting.** Rejected for this feature (#834): it helps answer during the call and goes with it.

## Consequences

- `Meeting.screen` says whether the bar asks, is reading which window, or why it stopped. `Settings › Meetings` has "Ask to read the shared screen when a meeting starts" (on by default), `Settings › Privacy` explains the shared screen, and the notice for attendees says what is shared on screen is read during the call and deleted when it ends.
- A Citation's Location has a "screen" kind, `{ kind: "screen", at }`, and is never checked again, calculated from or drawn as a cited page: there is nothing left to read.
- `electron-builder.yml` needs no new key for this: macOS shows its own Screen Recording prompt.
- Tests never capture a screen: the core's tests use a fake capture, the smoke tests share a test page the app opens in a hidden window of its own (as a tab is captured), and the fake recogniser reads what the test scripts.
