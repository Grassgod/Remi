# MUL-444 A: issue-detail test migration

The merged detail page uses the flat session log, manual sparse-window expansion,
and the shared stick-to-bottom state machine. The 14 removed component cases
asserted behavior of the deleted Virtuoso/timeline/fold path. Their surviving
behavior is covered as follows; the old fold controls are intentionally absent.

| Removed case | Current coverage |
| --- | --- |
| opens the conversation directly at its newest entry without an imperative jump | `use-stick-to-bottom.test.ts`: starts pinned; `issue-log-check.ts`: cold open at the correct position without jumps |
| loads older timeline rows from the top while preserving the logical anchor | `issue-log.test.ts`: locates a deep-link window and extends sparse ends; `issue-log-check.ts --step2`: expands both ends without displacement |
| decides follow-the-latest from the stick hook, not Virtuoso's 120px band | `use-stick-to-bottom.test.ts`: does not fight the user after release and honours `pinThresholdPx` |
| returns to following once the reader scrolls back to the end | `use-stick-to-bottom.test.ts`: releases on user scroll and re-pins on return |
| offers a jump-to-latest chip when scrolled away from the newest entry | `session-log-list.test.tsx`: counts new messages while released and returns on click; shows no chip while pinned |
| sends back-to-latest through the stick hook, not the virtualizer | `use-stick-to-bottom.test.ts`: walks released, returning, pinned through `returnToBottom` |
| collapses non-trailing activity blocks and expands the last one by default | `issue-detail.test.tsx`: renders all system log rows in seq order without folding |
| truncates the trailing activity block to the most recent 8 entries with a show-more toggle | `issue-detail.test.tsx`: renders all 10 system rows without truncation; `session-log-list.test.tsx` covers the shared DOM cap |
| does not show the show-more toggle when the trailing block has 8 or fewer entries | `issue-detail.test.tsx`: no obsolete show-more control for the flat log |
| expanding a non-trailing block shows every entry; only the trailing block truncates older ones | `issue-detail.test.tsx`: all system rows remain visible in seq order; `issue-log.test.ts` covers older-window expansion |
| loads older pages until the highlighted comment is available | `issue-log.test.ts`: locate then sparse-window expansion; `issue-log-check.ts --step2`: locate request precedes the anchored 15+15 window |
| scrolls to the highlighted comment after both issue and timeline finish loading | `issue-log-check.ts --step2`: target is centered and its highlight has stable height on cold open |
| still scrolls when the timeline is ready before the issue (inbox-click regression) | `issue-log-check.ts --step2`: inbox and comment-link navigation each reach the target with zero jumps |
| lands directly on a reply whose parent is folded away as resolved | `issue-detail.test.tsx` flat session stream: reply is a separate visible row; `issue-log.test.ts`: deep-link window locates a seq independently of earlier rows; `issue-log-check.ts --step2`: comment-link target is directly visible |

The retained detail cases still cover title, description, replies, attachments,
reactions, and issue-list request counts. The browser checks use production Next,
the local API and temporary data.
