# Acceptance cases for the rewrite (frozen 2026-10-24)

Owned by the reviewer, not the implementer. Run in P3 as a black-box script over MCP against the new build and the
test stack, on the new fixture pages (same routes). Each case passes or fails as written; a case is changed only with
the owner's agreement, and the change is recorded here.

Setup for every case: the test stack up, a single tab open unless the case says otherwise.

Where a case quotes an answer whose wording the spec leaves free (anything outside spec sections 4, 10, 11 and 12),
the case checks its parts and meaning (the ref, the counts, the URL, which outcome it reports), not the exact words.

## Interface

1. `tools/list` returns exactly the twelve tools in this order: navigate, back, snapshot, click, type, select, key,
   scroll, find, get_text, screenshot, upload (all `browser_`-prefixed), with the argument names, types, required
   lists and enums of spec section 2; `readOnlyHint` true for snapshot, find, get_text, screenshot only. (Amended
   2026-10-25 with the owner: eleven became twelve, `browser_upload` last; see case 42.)
2. Argument errors answer at once with the validator's messages: missing `url`, `url` 42, `screens` "two",
   `direction` "sideways", `mode` "pixels", an unknown argument.

## The view

3. A short page: header `Page: <title> — <url>` and `View: 0–<h> of <h> px (100%), <w>×<h>`, one line per element with
   a ref, no footer.
4. A long page (taller than four screens): the View line shows a percent below 100, thousands separators, and a
   footer line counting n > 0 elements below (wording free).
5. A form: a textbox line with its label as name; a dropdown line with nested option lines and `selected` on one; a
   button line; a heading line with `level=1`.
6. Index mode on the same form: only the textbox, dropdown, button and links; View line ends with
   a note that only interactive elements are listed (wording free).
7. A paragraph longer than the line limit ends with `… (+<n> chars: get_text <ref>)`.
8. Iframe content from another site appears under an `iframe` line.

## Refs

9. A ref still on the page works; after the page replaces that element, the same ref gets the "not on the page"
   error; so does `e99999`; so does a ref from before a reload. None of these answers contains "locator", "aria-ref"
   or a call log.
10. `#save` and `save button` get the "not a ref" error.

## Actions

11. Typing into a textbox answers that it typed into the ref, with a `~` line showing the new value.
12. Typing with `submit` into a form whose submit disables the button and shows an alert answers with a `~` line for
    the button (disabled) and a `+` line for the alert.
13. Choosing an option answers that it chose the option in the ref, with `~` lines moving `selected`.
14. Choosing an option that does not exist answers within 2 s with an error naming the options there are.
15. Typing into a button answers within 2 s with an error that it cannot be typed into.
16. A key with no visible effect answers with the combination pressed and that nothing visible changed; `ctrl+a` → `Control+a`,
    `cmd+shift+t` → `Meta+Shift+t`, `ctrl++` → `Control++`.
17. Clicking a link to another page answers with the ref clicked and the new URL, then the view.
18. Clicking a link with a target, and a button that opens a tab 150 ms later, each answer
    an answer that a new tab opened and is now followed, with the new tab's view, and the next snapshot shows the
    new tab.
19. A click that keeps the page busy for 1.5 s answers with its change, not a timeout.
20. A button that becomes clickable only after 4.5 s: a click with a 2 s call limit fails with the time-limit message,
    the next snapshot still shows the button disabled, and when the late click lands the next action's diff shows
    its effect (kept timeout test).

## Moving around

21. Scrolling a long page down by default moves the View top by 0.9 of the viewport height (±2 px).
22. `screens: 0.1` moves as 0.25; `screens: 50` moves as 10.
23. At the bottom, a scroll down answers starting with a line that the bottom is reached; at the
    top, a scroll up starts with a line that the top is reached; a scroll that moved never starts with such a line.
24. A page whose own panel scrolls (the body does not): repeated scrolls move through the panel, none says
    the end is reached until the panel's end, and the last view shows the panel's last line.
25. A sticky navigation that stays on screen unchanged during a scroll is named in
    a line saying it is left out as unchanged, and its lines are not repeated.
26. `browser_scroll` with the ref of an element far below brings it into the view.
27. Find: an off-screen heading by one word gives one line ending ` — <n> px below`; several words match only
    elements containing all of them, at most 15 lines, nearest first; a query with no match answers
    an answer that names the query and says nothing matched.
28. get_text on a long article with `max_chars: 300` returns at most 300 characters ending at a word boundary and a
    footer with the next offset; following the offsets reaches a last page whose footer gives no next offset; the
    pages joined equal the article's text.
29. `browser_back` after a navigation shows the previous page; with nothing behind, it answers with an error and the
    tab has not moved.
30. A navigation to `not a url` and to `http://nonexistent.invalid/` each answer with a short error with no call log
    and no `\x1b` escape codes.

## Screenshots

31. With one tab and with three tabs open (the followed one opened first): navigate, then screenshot, five times
    each: every screenshot answers within 3 s with one `image/jpeg` block.
32. A screenshot of one element by ref is a smaller JPEG than the full viewport.

## The cursor

33. After a click, `window.__agentCursor.where()` is within 4 px of the clicked element's centre, and a screenshot
    shows the arrow there.
34. Frames captured during type, choose and click show the glide (the arrow at intermediate points), the labels
    `Type · <field name>`, `Choose · <option>`, `Click · <button name>`, and never the typed text. Looked at, not
    only measured.
35. With `BROWSER_CURSOR=0` nothing is drawn: screenshots before and after a click show no arrow, and
    `window.__agentCursor` is undefined.
36. The page's own `querySelectorAll("*")` does not see the cursor, and page styles on page elements
    (`body * { display: none !important }`, rules on `div`, `[popover]`, `:popover-open`) do not hide it. (Amended
    2026-10-24 with the owner: a literal `* { display: none }` also hides `<html>`, which nothing in the page survives.)

## Fence (with BROWSER_ALLOWED_HOSTS)

37. All kept guard and policy integration tests pass unchanged (or with reviewed wording changes only).
38. A fresh browser's first snapshot under the fence answers the "The tab is on ..." refusal, and a navigation to an
    allowed page then works.

## Untrusted text

39. The hostile fixture page's answer starts with the override WARNING line, then the envelope, and a closing tag
    written by the page appears defanged inside it.
40. Each of the six signal categories fires on a plain example and none fires on a page of ordinary text.

## Session and timeouts

41. A page that never answers fails the call at the time limit with the time-limit message, and the next navigation
    succeeds with the right URL and page content (kept timeout test, tightened in P1).

## File upload (added 2026-10-25)

The acceptance checks of kis/intent/plan-file-upload.md, numbered on from here. Each names the test that proves it
(`test/integration/upload.test.mjs` unless it says otherwise).

42. `tools/list` returns twelve tools, `browser_upload` last: `ref` string and `files` array of strings with
    `minItems: 1`, both required, not read-only; `files: []`, `files: "x"` and `files: [1]` fail validation. Tests:
    `test/integration/tools.test.mjs` "twelve tools, in order, …" and "arguments are checked at once, …";
    `test/unit/guard.test.mjs` "the twelve tools keep their names, …"; `test/unit/server.test.mjs`.
43. One small fixture file uploaded to each fixture kind (visible input, label, button, input made on click, delayed
    chooser, same-site and cross-site frames, shadow DOM) answers with its full path and size; the page shows exactly
    one file with the same name, size and the SHA-256 `sha256sum` gives on the host. Tests: "each kind of upload
    control gets the file (acceptance 2)".
44. `multiple` takes two files (both hashes match); a single input given two answers that it takes one and keeps its
    earlier file; `webkitdirectory` is refused. Tests: "several files, one file, a folder (acceptance 3)".
45. Every refusal class answers its own message, with the page and the input unchanged and no click (the page's
    counter). Test: "each refusal of a path has its own answer, … (acceptance 4)" for relative path, missing, outside
    home, denied location, hard link, not a regular file, unreadable and too large; "changed while reading" needs a
    file changed between check and read, so it is shown in `test/unit/upload.test.mjs` ("a file changed between the
    check, the open and the read") and not here.
46. A drop zone with no chooser answers that it opened none, after exactly one click; a button that opens a pop-up
    answers that capture does not reach the new tab and no files were assigned, and the pop-up's input has none.
    Tests: "controls that open no chooser here (acceptance 5)".
47. `browser_click` on the chooser button answers with the hint naming its ref; the input keeps an earlier selection;
    no native dialog is open, then and 3 s later; afterwards a click from outside the session opens the native dialog
    again. Test: `test/integration/chooser.test.mjs`. A native dialog is seen by typing Escape on the container's
    desktop (`wtype`): one it closes fires the input's `cancel`, which the page counts; a desktop screenshot and a
    click by a person in the desktop were not used.
48. Uploads that navigate, open a tab, or are blocked by the allowlist answer like click does; an upload with no
    visible change says so; on a tab off the allowlist the call is refused with no click and no bytes sent. Tests:
    "uploads whose page then moves, or shows nothing (acceptance 7)" and "with BROWSER_ALLOWED_HOSTS (acceptance 7)".
49. An upload abandoned at the time limit whose assignment finishes late: the next action reports its changes against
    the last answer the agent received. Test: "an upload abandoned at its time limit (acceptance 8)".
50. Raw MCP results: a success and a Playwright error are inside the envelope; a fictional file whose path holds a
    closing envelope tag is defanged; a refusal for a denied name with a newline and a forged role marker carries
    neither; a page asking for an API key signals `secret-request`, an ordinary upload page does not. Tests: "raw
    results (acceptance 9)".
51. The cursor's tip ends on the input given the file, and nothing is put into the page with `BROWSER_CURSOR=0`.
    Tests: "the cursor (acceptance 10)". The label `Upload · <name>` is in a closed shadow root: looked at in a
    captured frame (2026-10-25, `Upload · Seed list file`), not measured.
52. Each new guard (validator, each path rule, the location recheck, the size cap, capture cleanup, the teardown
    barrier, the dispatch, refusal before click) was broken by a literal edit, its test failed, and the file was
    restored byte-identical. Recorded in each upload task's report (commits 4a44df9 to 9e95cbb), not a test file.
53. `npm test` passes, and the cases above (1 to 41) still pass. Proof: `npm test` locally; CI on the branch.
