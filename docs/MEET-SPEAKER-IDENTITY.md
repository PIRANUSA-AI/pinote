# Google Meet speaker identity investigation

Research date: 2026-09-23. Status: native-caption implementation added in extension
0.10.0; synthetic regression checks and both application builds pass. No native
identity capture has yet been validated against a live Meet session.

## Implemented path

`meetProtocol.js` decodes bounded protobuf caption v1/v2 and participant packets.
`meetPage.js` observes the native data channels and the specific roster sync
response at document start, without changing the original media or responses.
`meetBridge.js` enables native CC and hides its known rendering rows; it restores
CC on stop only when Rekapin enabled it. CC service remains enabled. This is NOT
a claim that transcription works with the caption service disabled. Unsupported
Meet DOM versions can require updates to the enable/hide adapter.

`meetTranscript.js` joins caption device IDs to the exact roster IDs, upserts
caption revisions, keeps unknown identities explicit, and resolves them if their
native roster entry arrives later. Names from the Rekapin login, DOM tiles,
microphone energy, text matching, and temporal overlap are not used for Meet.
The service worker validates the recorded tab, top frame, and capture session.
The side panel updates earlier rows when identity or caption revisions arrive.

Meet continues to record audio, but no longer sends that mixed audio to live
OpenAI ASR. Upload includes the native transcript in a separate database column.
The worker uses it as the transcript and skips both Deepgram re-attribution and
LLM transcript polishing. Existing insight generation uses the native transcript.
An empty native capture fails explicitly while retaining the uploaded recording;
it never silently falls back to guessed participant names. Other meeting platforms
and standalone audio uploads retain their existing transcription paths.

Names identify platform devices/accounts, not people sharing a microphone. Native
ID bindings are exact; Google's speech recognition can still transcribe words
incorrectly. Segment times currently reflect reception time, not sample-accurate
audio alignment. Caption language follows Meet's own setting, not the extension's
ASR language buttons.
Pause freezes existing caption revisions and rotates the capture session on
resume. If Meet continues the same caption across the pause, its remaining text
is skipped until the next native caption ID to avoid including paused speech.

## Deploy and use

1. Deploy the backend with generated migration `0013_old_micromacro.sql`. The
   existing Fly release command applies migrations. For a configured development
   database, run `npm --prefix backend run db:migrate`.
2. Install/reload extension 0.10.0, then reload the Meet tab BEFORE entering the
   call so the document-start hook can observe its connections.
3. Start Rekapin. If Chrome requests a tab, choose this same Meet tab with audio.
   The extension enables captions internally and hides the known caption rows.
4. Set the caption language in Meet to the spoken language. Unknown participant
   metadata is shown as `Identitas belum tersedia`, never inferred from the host.

The extension checks the backend's native-transcript capability in the create-job
response, preventing upload to an older backend that would discard the metadata.
Database migration, installation, and production deployment were NOT performed
as part of the local implementation.

## Verification

```
npm --prefix backend run build
npm --prefix frontend run build
node scripts/verifyMeetIdentity.mjs
npm run pack:extension
```

The regression script uses synthetic binary fixtures for six participants, equal
names, late identity, rejoin IDs, caption revisions, 64-bit event IDs, malformed
and oversized packets, compressed roster packets, upload validation, page-hook
session lifecycle, and CC restoration. These tests do not substitute for a live
Meet compatibility test or prove a transcription accuracy percentage.

## Required behavior

Rekapin must attach the meeting participant identity supplied by the platform to
each transcript segment. It must work with more than five meeting participants
without requiring visible closed captions. A guessed name is not an acceptable
substitute for an unresolved platform identity.

This identifies a meeting account/device, not an individual person sharing that
device's microphone. Participant display names can be duplicated or changed;
internal identity must therefore use participant IDs, not display names.

## Verified previous implementation (0.9.0)

- `extension/offscreen.js` mixes microphone and tab audio into a single stream
  before live ASR. Its energy comparison only estimates local versus remote.
- `backend/src/lib/liveTranscribe.ts` uses `OpenAiRealtimeSession` and returns
  text without participant identity. Deepgram is on the post-recording path.
- `extension/speakerWatch.js` polls caption/tile DOM. It does not consume native
  participant-to-media bindings. Avatar/structural-text fallbacks can mistake
  unrelated elements for names. It sends a name only when the name changes.
- `extension/background.js` guesses from a time-overlap window and a one-person
  roster fallback, otherwise returns `Peserta`. The final event's `until` is not
  refreshed until another event arrives, so long speaking turns lose coverage.
  Events are not restricted to the recorded tab, and reset does not clear the
  module's roster/speaker history.
- `backend/src/services/deepgram.ts::nameSpeakers` globally maps diarization IDs
  to names by temporal overlap. This cannot meet the explicit-identity contract.

The provisional caption-text-matching changes from this investigation were
removed after the requirement was clarified. They would still be heuristics.

## Evidence and limitations

1. Deepgram diarization assigns numeric speaker labels, not meeting account IDs:
   https://developers.deepgram.com/docs/diarization
2. Tactiq's current Meet instructions explicitly say visible CC need not be
   enabled. They do not document its private capture implementation:
   https://help.tactiq.io/en/articles/9535734-how-to-use-tactiq-with-google-meet-meetings
3. Tactiq documents that Teams participant naming depends on the platform's
   speaker-identification setting:
   https://help.tactiq.io/en/articles/9560779-how-to-use-tactiq-with-microsoft-teams-meetings
4. Google's official Meet Media API exposes participant metadata and media. Its
   current preview requires the Cloud project, OAuth principal, and all meeting
   participants to be enrolled. Virtual streams change owners; CSRC identifies
   the source. A track ID alone must not be treated as a permanent participant:
   https://developers.google.com/workspace/meet/media-api/guides/overview
5. Kuali's browser integration documents collection-based identity and encoded
   audio routing by CSRC. It ALSO uses activity correlation when native identity
   is unavailable. That fallback must not be carried into Rekapin's strict mode.
   The README documents three remote virtual audio lanes, not a three-person
   roster limit, and does not guarantee capture of every simultaneous speaker:
   https://github.com/igarrux/kuali/tree/main/browser-extension
6. MeetConnect describes protobuf caption and participant collections channels,
   but its linked source repository returned 404 during this investigation. Its
   marketing claims are not a validated protocol specification:
   https://meetconnect.ai/
7. Caption v1/v2 and roster wire-field definitions were cross-checked against the
   public Attendee capture adapter. Rekapin's decoder and bridge were implemented
   independently; no external capture library is loaded or executed:
   https://github.com/attendee-labs/attendee/blob/main/bots/google_meet_bot_adapter/google_meet_chromedriver_payload.js

## Architecture constraints

Two architectures were considered; this implementation selects native events:

- Native transcript events: join each event's explicit device/participant ID to
  the native participant registry. Persist native event ID and revision to
  replace partial captions without duplication. Verify subscription works with
  CC hidden; merely observing a channel is not proof that the server sends data.
- Separate native media: route each audio frame by its source identity and the
  platform's explicit participant binding BEFORE ASR. Carry that identity through
  the ASR response. Account for source reuse, overlap, reconnects, and mic mute.

Both need a MAIN-world hook installed at `document_start`, before Meet creates
its connections, and a validated, bounded bridge to the isolated content script.
Scope messages by recorded tab, document, and capture session. Preserve original
browser methods, events, and media flow; stop recording data on pause/stop.
Do not collect arbitrary request bodies, chat messages, credentials, or unrelated
data-channel traffic for diagnostics.

An ASR result from mixed audio must never acquire a verified-name label through
time overlap, text similarity, DOM glow, energy comparison, roster position, or
assuming the sole unmatched participant is the host. Keep unresolved identities
explicit, and resolve buffered events later only when the same native ID gets an
authoritative name. Preserve separate IDs even when display names are identical.

The post-recording pipeline now preserves the same provenance. Reprocessing a
mixed recording with Deepgram and assigning global names by overlap would undo
the correctness of native live attribution.

## Acceptance evidence

- First prove two accounts with CC not displayed, including the local account.
- Then test six or more accounts taking turns, short interjections, and overlap.
- Test participants offscreen, camera off, duplicate names, rename, leave/rejoin,
  source reuse, two open meeting tabs, pause/resume, and transport reconnects.
- Save sanitized native fixtures proving the participant-ID association. Test
  missing/out-of-order identity updates and caption revisions against fixtures.
- Unknown or unsupported protocol versions must not produce a guessed identity.
- Run backend/frontend builds and extension syntax/protocol checks. Builds alone
  do not validate an undocumented live Meet protocol or transcription accuracy.

A real meeting test is still needed to validate the native binding and the
no-visible-CC behavior; neither is established by screenshots or synthetic tests.
The user requested implementation first because a live test is not yet available.
