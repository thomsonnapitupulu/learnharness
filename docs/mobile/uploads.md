# Uploads from the phone: as built (story 3)

2026-11-22 · part of the [combined plan](combined-plan.md) (the "Uploads" section)

The agent's file tools read the server's disk, not the visitor's phone. So in a browser, **Attach** sends the picked file to the server first, and the message carries the file's path on the server. The agent then reads it the way it reads any attached path. Nothing serves an upload back to a browser.

## What the owner sees

- **Phone or any browser:** the paperclip opens the system picker directly (camera, photos, files on iOS and Android; the file dialog on a computer). Files can also be dropped on the window.
- **Progress:** each file shows a bar with its name and percentage in a small panel above the composer. Several files go one after another.
- **Done:** the path is added to the message as a chip, the same chip an attached path makes today. A failure is a sentence that names the file ("report.pdf is larger than 64 MiB, the most that can be attached.", "You were signed out. Sign in again, then attach report.pdf.", "… could not be sent. Check the connection and try again.").
- **Folders** cannot be uploaded. Dropping one says so, and dropping a folder with files attaches the files.
- **One drop at a time, and leaving stops it.** A second drop while one is sending is told to wait. Changing page (another session, home) stops an upload that is still going, so its path can never land in another session's message.
- **The desktop app on its own computer is unchanged:** it still opens the file and folder dialogs and attaches local paths. (Story 7 makes the desktop app, when it is pointed at a server, behave like a browser here, because a path on the computer means nothing on the server.)

Screens (a desktop-size browser, because the phone layout is story 4's): [uploading](screens/s3-uploading.png), [attached](screens/s3-attached.png), [too large](screens/s3-too-large.png).

## How it works

| Part | Where |
| --- | --- |
| Limits (64 MiB) | `lib/upload-limits.ts`, one constant used by the browser, the route and the message |
| Browser side: `uploadFile`, `uploadFiles` | `lib/upload-client.ts`. XMLHttpRequest rather than fetch, because only it reports upload progress. The file is the request body, the name is `?name=`. |
| Attach button and drop zone | `components/attach-files-button.tsx`, `components/file-path-drop-zone.tsx` |
| Route | `POST /api/uploads?name=…` (`app/api/uploads/route.ts`, logic in `src/server/upload-http.ts`). Replies `201 { id, name, size, path }`. Only POST is exported: Next answers every other method with `405` itself. |
| Storage | `src/server/uploads.ts`. `<data folder>/uploads/<id>/<name>`, folder mode 0700, file mode 0600. |

**The route is exempt from `proxy.ts`.** Next hands the proxy a copy of the request body that it cuts off at 25 MiB (`proxyClientMaxBodySize`), which would truncate a big upload before the route saw it. So the matcher in `proxy.ts` skips `/api/uploads`, and the handler does the proxy's two checks itself, before reading a byte: the API policy (allowed host, same-origin for writes, or the desktop capability), then the sign-in gate. The streamed document route already works this way.

**Streaming, not buffering.** The body is piped to the file through a counting stream. The size that is enforced is the bytes that actually arrive (a `Content-Length` can lie); a declared length over the limit is refused with `413` without reading anything. A transfer that fails or is cut off removes its folder, so nothing partial is left.

**Names.** The stored name is the browser's file name made safe: no folders, no control characters, not just dots, at most 200 bytes (the end is kept, where the extension is). The folder is named by a random id (`up_<time in base 36>_<12 hex>`), so two files with the same name never collide, and only an id of exactly that shape is ever turned into a path.

## Deleting

- **With the session.** An upload belongs to the session whose own messages (the learner's) carry its path. Deleting a session (`DELETE /api/chats/:id`) removes those uploads, after the record itself is gone. What the agent says or a tool result prints does not count: a listing of the uploads folder in one session would otherwise make that session the owner of every upload it listed. An upload that two sessions' own messages carry (a path pasted into both) is removed with whichever is deleted first; that is a known edge, noted for the owner.
- **Abandoned uploads.** A file picked into a draft that is never sent, or a transfer cut off midway, belongs to no session. The upload route sweeps at most once in six hours, in the background: uploads older than seven days that no session record mentions anywhere (the sweep is the careful one: any mention keeps an upload) are removed. If any record cannot be read, the sweep removes nothing.

## Where this differs from the plan

- The plan said `uploads/<session id>/`. A new session has no id yet when a file is picked, so the folder is named by its own upload id and tied to sessions by reference, as above.
- Deleting is by reference and a seven-day sweep, instead of by folder name.

## What the server setup (story 8) must provide

- **Caddy:** `request_body { max_size 70MB }` on the site, a little above 64 MiB, so the browser's refusal and the route's own refusal come first.
- **Disk:** uploads live in the data folder, so they are on the data disk and in its snapshots.
- **File access:** the agent's file tools are unrestricted by default (they refuse only credential files), so the service user can read `/srv/lh/data/uploads`. If the file-access setting is ever switched to a restricted mode, the uploads folder has to be allowed.
- **Next must keep the body streaming:** nothing in front of the route may buffer it. Caddy does not by default.

## Checked, and not checked

Checked in this story: the route's gate, limits, names and clean-up in `tests/uploads.test.ts`; the browser side with a fake `XMLHttpRequest` in `tests/composer-attach.test.tsx` and `tests/file-path-drop-zone.test.tsx`; the proxy exemption in `tests/plugin-document-proxy.test.ts`; and the real production server behind simulated Caddy headers (46 checks: 60 MiB in byte-for-byte, exactly 64 MiB accepted, 64 MiB plus one byte and 65 MiB chunked refused with nothing left, no session, a forged cookie, a cross-site write, a wrong host and plain http refused, a connection killed mid-transfer leaves nothing, deleting a session removes its upload and nobody else's, and the seven-day sweep keeps what a session mentions).

Not checked: a real phone's picker and camera (iOS HEIC photos arrive as the browser hands them over, with no conversion; whether a hidden file input opens from a home-screen web app on every iOS version), or a real Caddy in front.
