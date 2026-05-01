# Xojo Language Reference

This file is written by the **VSXojo** extension. It is not specific to any one AI tool —
Claude, Cline, Cursor, Copilot, Codex, and any other AI assistant can read it directly.

---

## Reserved words — do not use as identifiers

The following words are reserved by the Xojo compiler. **Never use them as variable names,
parameter names, method names, property names, or any other identifier.**

`#Bad` `#Else` `#ElseIf` `#EndIf` `#If` `#Pragma` `#Tag`
`AddHandler` `AddressOf` `Aggregates` `And` `Array` `As` `Assigns`
`Async` `Attributes` `Await` `Break` `ByRef` `ByVal` `Call` `Case`
`Catch` `Class` `Const` `Continue` `CType` `Declare` `Delegate` `Dim`
`Do` `DownTo` `Each` `Else` `ElseIf` `End` `Enum` `Event` `Exception`
`Exit` `Extends` `False` `Finally` `For` `Function` `Global` `GoTo`
`Handles` `If` `Implements` `In` `Inherits` `Interface` `Is` `IsA`
`Lib` `Loop` `Me` `Mod` `Module` `Namespace` `New` `Next` `Nil`
`Not` `Object` `Of` `Optional` `Or` `ParamArray` `Private` `Property`
`Protected` `Public` `Raise` `RaiseEvent` `ReDim` `Rem` `RemoveHandler`
`Return` `Select` `Self` `Shared` `Soft` `Static` `Step` `Structure`
`Sub` `Super` `Then` `To` `True` `Try` `Until` `Using` `Var`
`WeakAddressOf` `Wend` `While` `With` `Xor`

**Note:** Data types (`Integer`, `String`, `Double`, `Boolean`, etc.) are NOT reserved words
and may be used as identifiers, though it is poor style to do so.

**Also:** Do not begin any identifier with an underscore (`_`).

---

## Things that do NOT exist in Xojo — do not write them

These are constructs from other languages that Xojo does not support. The compiler will
reject them. Use the Xojo alternative shown instead.

### Parameters

| WRONG | RIGHT | Reason |
|---|---|---|
| `ByRef x() As T = Nil` | `ByRef x() As T` — no default | `ByRef` parameters **cannot** have a default value |
| `Sub Foo(x As Integer = 0, y As String)` | Put optional/defaulted params last | Parameters with defaults must come after all required parameters |

Valid parameter forms — all of these are legal:
```xojo
ByRef ResultArr() As String         // ByRef, no default (ok)
ResultArr() As String = Nil         // ByVal with Nil default (ok)
Optional ResultArr() As String      // Optional, no explicit default (ok)
```

### Operators that don't exist

| WRONG | RIGHT |
|---|---|
| `i++` or `i--` | `i = i + 1` or `i = i - 1` or `i += 1` |
| `x ? y : z` (ternary) | `If x Then y Else z` (single-line) or multi-line `If` block |
| `x ?? y` (null coalescing) | `If x = Nil Then y Else x` |
| `x \|\| y`, `x && y`, `!x` | `x Or y`, `x And y`, `Not x` |
| `x === y` (strict equality) | `x = y` (Xojo has no strict/loose distinction) |
| `10 \ 3` is integer division | **`\` IS the integer division operator in Xojo** — use `\` for integer result, `/` for Double result |

### String features that don't exist

| WRONG | RIGHT |
|---|---|
| `$"Hello {name}"` or `` `Hello ${name}` `` (interpolation) | `"Hello " + name` or `"Hello " & name` |
| Multi-line string literal with `"""..."""` or backticks | Concatenate across lines: `"line1" + Chr(10) + "line2"` |
| `s.length` or `s.Length` (API 1 style global function) | `s.Length` is correct in API 2; avoid global `Len(s)` |

### Type system

| WRONG | RIGHT |
|---|---|
| `null`, `None`, `nullptr`, `undefined` | `Nil` |
| `obj instanceof MyClass` or `type(obj) is MyClass` | `obj IsA MyClass` — returns Boolean |
| `obj is other` (identity) | `obj Is other` — Xojo `Is` tests object identity |
| `(MyClass)obj` or `obj as MyClass` (cast) | `CType(obj, MyClass)` or `MyClass(obj)` |

### Control flow

| WRONG | RIGHT |
|---|---|
| `break` | `Exit` (inside a loop exits the loop; `Exit For`, `Exit While` also valid) |
| `continue` | `Continue` (or `Continue For`, `Continue While`) |
| `return` in a Sub | `Return` (uppercase; in a Sub just `Return`, no value) |
| `foreach (x in collection)` | `For Each x As Type In collection ... Next` |
| `switch(x) { case 1: }` | `Select Case x` / `Case 1` / `End Select` |

### OOP / class features

| WRONG | RIGHT |
|---|---|
| `static int count` inside a method (class-level) | `Shared` property on the class |
| `this` | `Me` (or `Self` — same thing in most contexts) |
| `super.Method()` | `Super.Method()` |
| `lambda x: x + 1` or `x => x + 1` | `AddressOf methodName` (no inline lambdas) |
| No-argument constructor call: `MyClass.new` | `New MyClass` or `Dim obj As New MyClass` |

### Nil / object checks

```xojo
// All of these are equivalent and correct:
If obj = Nil Then ...
If obj Is Nil Then ...
If obj <> Nil Then ...

// WRONG — do not do this:
If obj == Nil Then ...   // == does not exist
If obj != Nil Then ...   // != does not exist
If obj Is Not Nil Then ...  // no "Is Not" — use <> Nil or Not (obj Is Nil)
```

### Array declaration gotcha

```xojo
Dim arr(9) As String    // declares 10 elements: indices 0 through 9
                        // the argument is the LAST INDEX, not the count
Dim arr(0) As String    // 1 element (index 0)
Dim arr() As String     // empty array (size 0, use Append to add)
```

Do **not** write `Dim arr(10) As String` when you want 10 elements — that gives you 11 (0–10).

### No short-circuit: guard against Nil before accessing members

Xojo evaluates both sides of `And`/`Or` — there is no guaranteed short-circuit.
Always check for Nil with a separate `If` before accessing an object's members:

```xojo
// WRONG — may crash even if obj = Nil
If obj <> Nil And obj.Value > 0 Then ...

// RIGHT — explicit guard
If obj <> Nil Then
  If obj.Value > 0 Then ...
End If
```

---

## Style rule — variable declarations

Xojo has two declaration keywords: `Dim` (traditional, works in all versions) and `Var`
(introduced in API 2.0 / Xojo 2019r2). **Match the style already used in the project you are
working on.** If the existing code uses `Dim`, keep using `Dim`. Do not silently replace `Dim`
with `Var` or vice versa unless the user specifically asks.

---

## Core language syntax

### Subs and Functions

```xojo
Sub MethodName(param1 As String, param2 As Integer)
  // body
End Sub

Function MethodName(param As String) As Boolean
  Return True
End Function
```

- No parentheses required when calling a Sub with no arguments: `DoSomething` or `DoSomething()`
- `Return` exits early or returns a value from a Function
- `ByRef` passes a parameter by reference: `Sub Swap(ByRef a As Integer, ByRef b As Integer)`
- `ParamArray` accepts variable number of arguments: `Sub Log(ParamArray items() As String)`
- `Optional` marks an optional parameter: `Sub Show(msg As String, Optional title As String = "")`

### Variable declaration

```xojo
Dim name As String           // traditional (works in all Xojo versions)
Var name As String           // API 2.0 alternative (Xojo 2019r2+)
Dim count As Integer = 0
Dim items() As String        // array
Static total As Integer      // retains value between calls
```

### Control flow

```xojo
If condition Then
  // ...
ElseIf otherCondition Then
  // ...
Else
  // ...
End If

// Single-line form
If x > 0 Then DoSomething

Select Case value
  Case 1
    // ...
  Case 2, 3
    // ...
  Case Else
    // ...
End Select

For i As Integer = 0 To 10
  // ...
Next

For i As Integer = 10 DownTo 0 Step 2
  // ...
Next

For Each item As String In myArray
  // ...
Next

While condition
  // ...
Wend

Do
  // ...
Loop Until condition

Do While condition
  // ...
Loop
```

- `Continue` skips to the next loop iteration
- `Exit` (or `Break`) exits the innermost loop
- `GoTo labelName` — `labelName:` (avoid; legacy use only)

---

## Data types

| Type | Description | Default |
|---|---|---|
| `Boolean` | True / False | False |
| `Integer` | 32-bit signed integer (-2,147,483,648 to 2,147,483,647) | 0 |
| `Int8`, `Int16`, `Int32`, `Int64` | Explicit-width integers | 0 |
| `UInt8`, `UInt16`, `UInt32`, `UInt64` | Unsigned integers | 0 |
| `Single` | 32-bit float | 0.0 |
| `Double` | 64-bit float | 0.0 |
| `String` | Unicode text | "" |
| `Color` | RGBA color value | &c000000 |
| `Currency` | Fixed-point financial number | 0 |
| `DateTime` | Date + time (API 2.0); replaces `Date` class | — |
| `Variant` | Dynamically typed; holds any value | Nil |
| `Auto` | Type inferred at compile time | — |

**Type conversion:**

```xojo
Dim s As String = Str(42)          // Integer to String
Dim n As Integer = Val("42")        // String to Integer (returns Double, implicit cast)
Dim n As Integer = Integer.FromString("42")  // preferred API 2.0 form
Dim d As Double = CDbl("3.14")
CType(expression, TypeName)         // explicit type cast
```

**Nil:** Xojo's null. All object types can be Nil. Check: `If obj = Nil Then` or `If obj Is Nil Then`.

**Color literals:** `&cRRGGBB` or `&cRRGGBBAA` (hex). Example: `&cFF0000` is red.

---

## Strings

```xojo
Dim s As String = "Hello"
s = s + " World"                  // concatenation with +
s = s & " World"                  // concatenation with & (same result)
s.Length                          // character count
s.ToUpperCase / s.ToLowerCase
s.Trim / s.TrimLeft / s.TrimRight
s.Left(n) / s.Right(n) / s.Middle(start, length)
s.IndexOf("sub")                  // returns -1 if not found
s.ReplaceAll("old", "new")        // returns modified copy
s.Split(",")                      // returns String array
s.StartsWith("prefix") / s.EndsWith("suffix")
String.FromArray(arr, delimiter)  // join array elements

// Format a number
Dim formatted As String = Format(3.14, "0.00")
```

**API 1 → API 2 string function changes:**

| API 1 (deprecated) | API 2 replacement |
|---|---|
| `Len(s)` | `s.Length` |
| `Left(s, n)` | `s.Left(n)` |
| `Right(s, n)` | `s.Right(n)` |
| `Mid(s, start, len)` | `s.Middle(start, len)` |
| `InStr(s, sub)` | `s.IndexOf(sub)` |
| `Replace(s, old, new)` | `s.ReplaceAll(old, new)` |
| `Trim(s)` | `s.Trim` |
| `LCase(s)` / `UCase(s)` | `s.ToLowerCase` / `s.ToUpperCase` |

---

## Arrays

```xojo
Dim names() As String             // empty array
Dim nums(9) As Integer            // 10 elements, indices 0–9
Dim grid(3, 3) As Double          // 2D array

names.Append("Alice")             // add to end (API 2: names.Add("Alice"))
names.AddAt(0, "Bob")             // insert at index
names.Remove(0)                   // remove by index (API 1)
names.RemoveAt(0)                 // remove by index (API 2)
names.Count                       // number of elements
names.LastIndex                   // last valid index (= Count - 1)
Redim names(newSize)              // resize (API 1)
names.ResizeTo(newSize)           // resize (API 2)

For Each n As String In names
  // ...
Next
```

Array assignment copies a **reference** (not a deep copy). Use a loop to duplicate contents.

---

## Dictionary

```xojo
Dim d As New Dictionary
d.Value("key") = "value"
Dim v As String = d.Value("key")
If d.HasKey("key") Then ...
d.Remove("key")
d.Count                           // number of entries

// Iterate
For Each entry As DictionaryEntry In d
  Dim k As String = entry.Key
  Dim v As Variant = entry.Value
Next
```

Dictionary keys are case-sensitive by default. Values are `Variant`.

---

## Object-oriented programming

### Classes and Modules

```xojo
// Class definition (in the IDE — reflected in XML as a Module block with IsClass=1)
Class MyClass
  Inherits BaseClass
  Implements SomeInterface

  // Constructor
  Sub Constructor(param As String)
    Super.Constructor()
    // init
  End Sub

  // Destructor
  Sub Destructor()
    // cleanup
  End Sub
End Class
```

- `Me` — the current instance (equivalent to `this` in other languages)
- `Self` — same as `Me` inside most contexts; inside a Shared method, `Self` is the class itself
- `Super` — the parent class; use `Super.MethodName()` to call overridden base methods
- `New` — creates an instance: `Dim obj As New MyClass("hello")`
- `Shared` methods/properties belong to the class, not an instance

### Interfaces

```xojo
Interface Printable
  Sub Print()
  Function Description() As String
End Interface

Class MyDoc
  Implements Printable
  Sub Print()
    // ...
  End Sub
  Function Description() As String
    Return "My document"
  End Function
End Class
```

### Events

```xojo
// Declare an event in a class
Event DataReady(data As String)

// Raise it
RaiseEvent DataReady("payload")

// Handle it externally with AddHandler / RemoveHandler
AddHandler obj.DataReady, AddressOf MyHandler
RemoveHandler obj.DataReady, AddressOf MyHandler

Sub MyHandler(data As String)
  // ...
End Sub
```

- `AddressOf methodName` — gets a reference to a method for use with AddHandler
- `WeakAddressOf methodName` — weak reference version (won't prevent garbage collection)

### WeakRef

```xojo
Dim wr As New WeakRef(someObject)
If wr.Value <> Nil Then
  Dim obj As MyClass = MyClass(wr.Value)
  // use obj
End If
```

Use WeakRef to hold a reference that doesn't prevent garbage collection (avoids retain cycles).

---

## Error handling

```xojo
Try
  // code that might fail
  Dim f As New FolderItem("/missing/path")
  Dim stream As TextInputStream = TextInputStream.Open(f)
Catch e As IOException
  // handle IO errors
  MsgBox "IO error: " + e.Message
Catch e As RuntimeException
  // catch-all for runtime errors
  MsgBox "Error: " + e.Message
Finally
  // always runs (cleanup)
End Try

// Raise your own exception
Raise New RuntimeException("Something went wrong")

// Custom exception class (inherits RuntimeException)
Class MyException
  Inherits RuntimeException
End Class
Raise New MyException("details")
```

Common exception types: `RuntimeException`, `IOException`, `OutOfMemoryException`,
`NilObjectException`, `UnsupportedFormatException`, `KeyNotFoundException`,
`InvalidArgumentException`, `OutOfBoundsException`.

---

## File I/O

### Reading a text file

```xojo
Dim f As New FolderItem("/path/to/file.txt", FolderItem.PathModes.Native)
If f <> Nil And f.Exists Then
  Dim stream As TextInputStream = TextInputStream.Open(f)
  While Not stream.EndOfFile
    Dim line As String = stream.ReadLine
    // process line
  Wend
  stream.Close
End If
```

### Writing a text file

```xojo
Dim f As New FolderItem("/path/to/output.txt", FolderItem.PathModes.Native)
Dim stream As TextOutputStream = TextOutputStream.Create(f)
stream.WriteLine "Hello"
stream.Write "no newline"
stream.Close
```

### FolderItem navigation

```xojo
Dim f As New FolderItem("/some/dir", FolderItem.PathModes.Native)
f.Exists         // Boolean
f.IsFolder       // Boolean
f.Name           // filename
f.NativePath     // full OS path string
f.Parent         // parent FolderItem (Nil at root)
f.Child("sub")   // child item by name
f.Count          // number of children (expensive — cache it)
```

**API 1 → API 2 FolderItem changes:**

| API 1 (deprecated) | API 2 replacement |
|---|---|
| `f.AbsolutePath` | `f.NativePath` |
| `f.ShellPath` | `f.NativePath` (or `ShellPath` where needed) |
| `f.ModificationDate` | `f.ModificationDateTime` (DateTime) |
| `f.CreationDate` | `f.CreationDateTime` (DateTime) |
| `TextInputStream.Open(f)` using old constructors | `TextInputStream.Open(f)` (same) |
| Path delimiters: `:` on macOS | `/` on all platforms (API 2) |

### SpecialFolder

```xojo
SpecialFolder.Desktop
SpecialFolder.Documents
SpecialFolder.ApplicationData
SpecialFolder.Temporary
SpecialFolder.Applications
```

---

## DateTime (API 2.0 replacement for Date)

```xojo
Dim now As DateTime = DateTime.Now
Dim d As New DateTime(2024, 6, 15, 10, 30, 0)  // year, month, day, hour, min, sec

now.Year / now.Month / now.Day
now.Hour / now.Minute / now.Second
now.DayOfWeek          // 0=Sun, 1=Mon, ..., 6=Sat
now.SecondsFrom1970    // Unix timestamp as Double

// Formatting
Dim s As String = now.ToString("yyyy-MM-dd HH:mm:ss")

// Arithmetic
Dim interval As New DateInterval(0, 0, 7)   // 7 days
Dim next As DateTime = now + interval
```

`Date` (API 1) is deprecated. Use `DateTime` in new code.

---

## Threading

### Thread

```xojo
// In a class with a Thread control or Thread object:
Dim t As New Thread
AddHandler t.Run, AddressOf ThreadBody
t.Start

Sub ThreadBody()
  // runs on background thread
  // DO NOT directly update UI from here
End Sub
```

**Critical rule:** UI controls can only be updated on the **main thread**. Use a `Timer` with
0ms delay or `App.CallLater` to marshal work back to the main thread.

### Timer

```xojo
Dim t As New Timer
t.Period = 1000        // milliseconds
t.Mode = Timer.Modes.Multiple  // or Single, Off
AddHandler t.Action, AddressOf OnTimer

Sub OnTimer()
  // runs on main thread — safe to update UI
End Sub
```

`Timer.Modes.Single` fires once then stops. `Timer.Modes.Multiple` fires repeatedly.
`Timer.Modes.Off` disables the timer.

### CriticalSection

```xojo
Dim cs As New CriticalSection
cs.Enter
  // protected block — only one thread at a time
cs.Leave
```

Always `Leave` in a `Finally` block to avoid deadlocks.

---

## Advanced features

### Declare — calling native OS APIs

```xojo
// Windows
Declare Function MessageBox Lib "User32" Alias "MessageBoxW" _
  (hwnd As Integer, text As WString, caption As WString, utype As Integer) As Integer

// macOS
Declare Function NSApplicationMain Lib "AppKit" (argc As Integer, argv As Ptr) As Integer
```

- `Lib` specifies the DLL/dylib name
- `Alias` maps to the actual exported symbol name
- `WString` for Windows wide-character strings; `CString` for C-style null-terminated strings
- `Ptr` for opaque pointers; `MemoryBlock` for structured data buffers
- Use `#If TargetWindows / TargetMacOS / TargetLinux` to guard platform-specific Declares

### Pragma directives

```xojo
#Pragma BackgroundTasks False     // disable background task switching
#Pragma BoundsChecking False      // disable array bounds checking (faster, less safe)
#Pragma NilObjectChecking False   // disable nil dereference checks
#Pragma StackOverflowChecking False
```

Use Pragma sparingly in hot-code paths; they trade safety for performance.

### Introspection

```xojo
Dim ti As Introspection.TypeInfo = Introspection.GetType(someObject)
ti.Name                                    // class name
ti.Methods                                 // array of MethodInfo
ti.Properties                              // array of PropertyInfo
ti.Interfaces                              // array of TypeInfo

For Each m As Introspection.MethodInfo In ti.Methods
  m.Name
  m.Invoke(someObject, New Variant()(0))   // call the method
Next
```

Introspection is a runtime reflection API — use it to inspect unknown objects, build
generic serialisers, or implement plugin architectures.

### MemoryBlock

```xojo
Dim mb As New MemoryBlock(1024)    // 1 KB block
mb.StringValue(0, 4) = "RIFF"     // write 4 bytes at offset 0
Dim b As UInt8 = mb.Byte(5)       // read a single byte
mb.Int32Value(8) = 42             // write 32-bit int at offset 8
mb.Size                            // block size in bytes
```

Used for binary file I/O, interop with native libraries, and low-level data manipulation.

---

## Compiler directives

```xojo
#If TargetWindows Then
  // Windows-only code
#ElseIf TargetMacOS Then
  // macOS-only code
#ElseIf TargetLinux Then
  // Linux-only code
#ElseIf TargetIOS Then
  // iOS-only code
#ElseIf TargetAndroid Then
  // Android-only code
#End If

#If TargetDesktop Then ... #End If   // Desktop (Win/Mac/Linux)
#If TargetMobile Then  ... #End If   // iOS + Android
#If TargetWeb Then     ... #End If   // Web apps
#If Target32Bit Then   ... #End If
#If Target64Bit Then   ... #End If
#If DebugBuild Then    ... #End If
#If Not DebugBuild Then ... #End If  // release build
```

---

## API 2.0 — key class renames (Xojo 2019r2+)

API 2.0 introduced `Desktop`-prefixed names for desktop UI controls and a new `Mobile`
framework. Old names still compile (they are deprecated, not removed) but should not be
used in new code. Match the style of the existing project.

### Desktop UI controls

| API 1 (deprecated) | API 2 replacement |
|---|---|
| `Window` | `DesktopWindow` |
| `Canvas` | `DesktopCanvas` |
| `PushButton` | `DesktopButton` |
| `CheckBox` | `DesktopCheckBox` |
| `RadioButton` | `DesktopRadioButton` |
| `Label` | `DesktopLabel` |
| `TextField` | `DesktopTextField` |
| `TextArea` | `DesktopTextArea` |
| `ListBox` | `DesktopListBox` |
| `ComboBox` | `DesktopComboBox` |
| `Slider` | `DesktopSlider` |
| `ProgressBar` | `DesktopProgressBar` |
| `PopupMenu` | `DesktopPopupMenu` |
| `SegmentedControl` | `DesktopSegmentedControl` |
| `ContainerControl` | `DesktopContainer` |
| `PagePanel` | `DesktopPagePanel` |
| `TabPanel` | `DesktopTabPanel` |
| `ScrollBar` | `DesktopScrollBar` |
| `MoviePlayer` | `DesktopMoviePlayer` |
| `HTMLViewer` | `DesktopHTMLViewer` |
| `MenuItem` | `DesktopMenuItem` |
| `Toolbar` | `DesktopToolbar` |

### Mobile (replaces iOS framework)

| API 1 (deprecated) | API 2 replacement |
|---|---|
| `iOSView` | `MobileScreen` |
| `iOSButton` | `MobileButton` |
| `iOSLabel` | `MobileLabel` |
| `iOSTextField` | `MobileTextField` |
| `iOSTextArea` | `MobileTextArea` |
| `iOSTable` | `MobileTable` |
| `iOSApplication` | `MobileApplication` |

### Other API 2 renames

| API 1 (deprecated) | API 2 replacement | Notes |
|---|---|---|
| `Date` | `DateTime` | Full date+time class |
| `Redim arr(n)` | `arr.ResizeTo(n)` | Resize array |
| `App` | `Application` | Application object |
| `Serial` | `SerialConnection` | Serial port |
| `Serial.DataAvailable` event | `SerialConnection.DataReceived` | |
| `HTTPSocket` | `URLConnection` | HTTP client |
| `SMTPSocket` | `SMTPSecureSocket` | Email |
| `POP3Socket` | `POP3SecureSocket` | Email receive |
| `RecordSet` | `RowSet` | Database result set |
| `DatabaseRecord` | `DatabaseRow` | Database row |
| `SQLiteBLOB` errors via properties | Raises `IOException` | |
| `SpecialFolder.Var` | `SpecialFolder.Variable` | |
| `SpecialFolder.VarLog` | `SpecialFolder.VariableLog` | |

---

## Databases

```xojo
// Open SQLite database
Dim db As New SQLiteDatabase
db.DatabaseFile = New FolderItem("/path/to/db.sqlite", FolderItem.PathModes.Native)
If Not db.Connect Then
  MsgBox "Could not open database: " + db.ErrorMessage
  Return
End If

// Execute non-query SQL
db.ExecuteSQL("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)")

// Query
Dim rows As RowSet = db.SelectSQL("SELECT * FROM users WHERE id = ?", userId)
While Not rows.AfterLastRow
  Dim name As String = rows.Column("name").StringValue
  rows.MoveToNextRow
Wend
rows.Close

// Prepared statement
Dim ps As SQLitePreparedStatement = db.Prepare("INSERT INTO users (name) VALUES (?)")
ps.BindType(0, SQLitePreparedStatement.SQLITE_TEXT)
ps.Bind(0, "Alice")
ps.ExecuteSQL

db.Close
```

---

## Networking (URLConnection — API 2)

```xojo
// GET request (asynchronous via events)
Dim http As New URLConnection
AddHandler http.ContentReceived, AddressOf OnContent
http.Send("GET", "https://api.example.com/data")

Sub OnContent(url As String, httpStatus As Integer, content As String)
  If httpStatus = 200 Then
    // process content
  End If
End Sub

// POST with body
http.RequestContent = "{""key"":""value""}"
http.RequestContentType = "application/json"
http.Send("POST", "https://api.example.com/endpoint")
```

`HTTPSocket` (API 1) is deprecated; use `URLConnection` for new code.

---

## Constants and Enumerations

```xojo
Const MAX_SIZE As Integer = 100
Const APP_NAME As String = "MyApp"

// Enumeration
Enum Status
  Pending = 0
  Active = 1
  Closed = 2
End Enum

Dim s As Status = Status.Active
```

---

## Useful global functions and keywords

| Item | Description |
|---|---|
| `MsgBox(s)` / `MessageBox(s)` | Show message dialog |
| `InputBox(prompt)` | Show input dialog (returns String) |
| `Str(n)` | Number to String |
| `Val(s)` | String to Double |
| `CStr(v)` | Variant to String |
| `CInt(v)` | Variant to Integer |
| `CDbl(v)` | Variant to Double |
| `CBool(v)` | Variant to Boolean |
| `IsNumeric(s)` | Test if string is a number |
| `IsNull(v)` | Test if Variant is Null (different from Nil) |
| `Format(n, pattern)` | Format number as string |
| `CurrentMethodName` | Returns name of current method as String |
| `IsDebugBuild` | True if running in debug mode |
| `XojoVersion` / `XojoVersionString` | Compiler version |
| `App.DoEvents` | Process pending UI events (use sparingly) |
| `Runtime.MemoryUsed` | Current memory usage |
| `VarType(v)` | Returns type ID of a Variant |

---

## Online documentation

Full API reference: https://documentation.xojo.com/api/
API 2.0 migration guide: https://documentation.xojo.com/resources/updating_older_projects.html
Deprecated API list: https://documentation.xojo.com/api/deprecated/
