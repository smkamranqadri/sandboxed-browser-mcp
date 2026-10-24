# Acceptance cases for the rewrite (frozen 2026-10-24)

Owned by the reviewer, not the implementer. Run in P3 as a black-box script over MCP against the new build and the
test stack, on the new fixture pages (same routes). Each case passes or fails as written; a case is changed only with
the owner's agreement, and the change is recorded here.

Setup for every case: the test stack up, a single tab open unless the case says otherwise.

Where a case quotes an answer whose wording the spec leaves free (anything outside spec sections 4, 10, 11 and 12),
the case checks its parts and meaning (the ref, the counts, the URL, which outcome it reports), not the exact words.

## Interface

1. `tools/list` returns exactly the eleven tools in this order: navigate, back, snapshot, click, type, select, key,
   scroll, find, get_text, screenshot (all `browser_`-prefixed), with the argument names, types, required lists and
   enums of spec section 2; `readOnlyHint` true for snapshot, find, get_text, screenshot only.
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
