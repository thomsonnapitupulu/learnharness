# Moving your desktop data to the server

2026-11-22 · Thomson Simplify · story 8 of the mobile epic, as built. Part of the [hosting guide](hosting-guide.md), which sets up the server first. Decided in the [combined plan](combined-plan.md#moving-current-data-to-aws).

> **Not yet run against a real server.** The import script was tested on fake folders and zips ([what was tested](hosting-guide.md#what-was-and-was-not-tested)). Your data on the Mac is not changed by any step here, so the worst case is a retry.

## What moves

The installed desktop app keeps everything in one folder. On macOS it is `~/Library/Application Support/LearnHarness/`. Two things in it move:

| What | Holds |
| --- | --- |
| `data/` | Sessions, plans, notes, the graph, flashcards, settings, prompt overrides, plugin data |
| `auth.json` | Your API keys |

Left behind on purpose: `logs/`, and the subscription sign-ins (`*-credentials.json`) because the server uses API keys only.

The server runs this repository's version of LearnHarness, which has to be the same as or newer than the desktop app that wrote the data. It is, unless you have updated the desktop app past this fork in the meantime.

## Do it once, before using the server for real

The import **replaces** the server's data with the zip's. It does not merge. The server's earlier data is moved aside, not deleted, but whatever you did on the server before the import is no longer what the app shows. So import first, then use the server.

## Steps

1. **Quit LearnHarness on the Mac** (Cmd+Q), so nothing is written while you copy.
2. **Zip the two items.** In Finder, Go, **Go to Folder…** (Shift+Cmd+G), paste `~/Library/Application Support/LearnHarness`, select `data` and `auth.json`, right-click, **Compress 2 Items**, and rename the result `learnharness-data.zip`. Or in Terminal, which also puts it on the Desktop:

   ```bash
   cd ~/"Library/Application Support/LearnHarness" && zip -r ~/Desktop/learnharness-data.zip data auth.json
   ```

   Keep this zip. It is your backup, and it holds your API keys, so keep it somewhere private.
3. **Upload it to the migration bucket.** The stack's **Outputs** tab shows its name as `MigrationBucket`. In the S3 console open that bucket, **Upload**, add the zip. Or with the AWS CLI: `aws s3 cp ~/Desktop/learnharness-data.zip s3://<bucket>/`. The bucket is private, encrypted and forgets files after 7 days.
4. **Run the import on the server.** Open a shell as in [the hosting guide](hosting-guide.md#4-set-the-password), then:

   ```bash
   sudo /opt/learnharness/deploy/aws/import-data.sh s3://<bucket>/learnharness-data.zip
   ```

   It downloads the zip and checks that it looks like LearnHarness data, then copies it next to its final place on the data disk first, so a failure here changes nothing. After that it stops the site, moves what the server had to `data.before-import-<time>` (and `auth.json.before-import-<time>`), puts your data in place with the right owner and permissions, and starts the site again. It stops with a message, and changes nothing, when the zip has no `data` folder or the folder does not look like LearnHarness data. A zip of the whole `LearnHarness` folder also works. Your server password and sign-in state (`access.json`) are never touched, so your phone stays signed in.
5. **Look around on the phone or in a browser.** Check that the session list is there, that a session opens, that the graph shows, that a lesson resumes where it was, and that Settings, Providers shows your keys as set. Send one message to see that a key works.
6. **Clean up.** Delete the zip from the bucket, because it holds your keys (S3 console, select it, Delete). Once you are sure, delete the old copies on the server: `sudo sh -c 'rm -r /srv/lh/data.before-import-*; rm -f /srv/lh/auth.json.before-import-*'`.
7. **Stop using the old copy.** Use the server from the phone and from a browser or the desktop app's Server setting ([hosting guide](hosting-guide.md#the-desktop-app-and-your-mac)). The folder on the Mac stays as it is, and nothing syncs back, so what you do on the server does not reach it. Using both would make two diverging copies.

## What looks different afterwards

| Item | After the move |
| --- | --- |
| Sessions, plans, notes, graph, flashcards, prompts, plugins | As before |
| API keys | As before. If one fails, enter it again in Settings, Providers |
| Images shown in lessons | Still show: they are saved inside the sessions |
| Files attached by path in old sessions | The path is on your Mac, so the agent cannot open them on the server. Attach them again, which uploads them |
| Settings that name a folder on your Mac (such as folders the agent may read) | Point at nothing on the server. Review them in Settings |

## If something is wrong

The import keeps what the server had. To put it back right after an import:

```bash
sudo systemctl stop learnharness
sudo mv /srv/lh/data /srv/lh/data.imported
sudo mv /srv/lh/data.before-import-<time> /srv/lh/data
sudo systemctl start learnharness
```

Do the same with `auth.json` and `auth.json.before-import-<time>` if the keys are the problem. You can also run the import again with a fresh zip; each run moves the current data aside first.

If the import stops with "the site did not answer", the data is already in place. Read `journalctl -u learnharness -n 100` for why the app does not start.
