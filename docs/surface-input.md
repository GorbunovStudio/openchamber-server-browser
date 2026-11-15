# Surface input backpressure

The host forwards viewer input packets serially. Waiting for Chrome to
acknowledge every pointer move and wheel before accepting the next packet can
build seconds of delay when the viewer produces input faster than Chrome
acknowledges it.

The surface accepts ordinary wheel events and pointer moves without held buttons
promptly, then dispatches them from a surface-owned queue. Wheels are dispatched
one at a time; hover moves can have outstanding acknowledgements. Compatible
adjacent pending wheels are merged across packets, preserving the total delta.
Adjacent pending hover moves with identical modifiers keep only the latest
position. Already dispatched input is never merged or replayed.

## Ordering and boundaries

- Wheel position, modifiers, direction changes, intervening input and numeric
  overflow prevent merging. Ctrl/Meta wheels remain blocking and unmerged
  because zoom is not equivalent to adding scroll distance.
- Clicks, keys, inserted text, held-button drag moves and context-menu handling
  wait for preceding continuous input.
- Clipboard reads, resizing, viewport configuration, browser commands, agent
  actions and changes of controller also drain preceding input. Repeated claims
  by the same controller do not: the manager repeats its claim for every packet.
- Retargeting and closing cancel unsent input. Already submitted commands remain
  bound to their original CDP session; late completions cannot drain the new
  target's queue or report old errors against it.
- Asynchronous failures appear in browser problem state and reject the next
  input or drain barrier rather than disappearing.

Do not pipeline wheel dispatch itself. Chrome can acknowledge a pipelined wheel
before its handler receives it, allowing a following key to overtake preceding
scrolling. Serial wheel dispatch preserves event ordering, but does not promise
that Chrome's smooth-scroll animation has finished before a subsequent key.

## Validation

`npm test` includes gated acknowledgement tests for pending-event merging,
ordering barriers, errors and retarget cancellation. Real-Chrome integration
tests cover nested scrollable areas and iframe contents, complete scroll
distance, and key/click handlers observing the preceding wheel delta. Tests also
exercise HiDPI coordinates, clipboard behavior, context menus and drag selection.

The change requires no new dependencies or OpenChamber core modifications.
Rendering density, JPEG quality and frame cadence remain unchanged.
