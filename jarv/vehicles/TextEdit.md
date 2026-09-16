# vehicle: TextEdit

Plain text editor with a real AppleScript dictionary — the classic osascript key.
No bundled scripting runtime and no console door; script it directly.

- driver: osascript
- app:    TextEdit
- doors:  tell application "TextEdit" (documents, string of document, make new
          document, close) + System Events for menus/keystrokes

Key snippets:
  tell application "TextEdit"
    set theText to "hello from jarv"
    set newDoc to make new document with properties {text:theText}
    set result to (count of documents)
    save front document
  end tell

Doctrine:
  1. `tell application "TextEdit"` is Cocoa-scriptable — read/write document
     text directly; never type into the window for basic edits.
  2. Menus, find panels and formatting still live in System Events if needed
     (`!kit app ui TextEdit`).
  3. Write text with `set contents of front document to ...`; ask with
     `get text of front document`.