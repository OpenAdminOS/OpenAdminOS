---
title: "Uninstall and reset"
description: "Remove OpenAdminOS and its local data from a device, and revoke its access in Entra."
---

# Uninstall and reset

Removing the app alone does not remove its data. The data folder, the stored
Microsoft sign-ins and the encryption key that protects them stay on the
device, so a reinstall opens with the same organizations already signed in.
To start clean, reset OpenAdminOS first, then uninstall it.

Neither a reset nor an uninstall changes anything in your tenants. The
OpenAdminOS enterprise application and the admin consent granted to it stay in
Microsoft Entra until you revoke them there. See
[Revoke access in Entra](#revoke-access-in-entra).

## Reset OpenAdminOS in the app

Open **Settings > Data** and choose **Reset OpenAdminOS**. The dialog shows the
data folder and what is removed. Type `RESET OPENADMINOS` exactly and choose
**Reset and restart**.

OpenAdminOS then signs out of every organization, turns off the background
scheduler and the menu bar login item, stops its background work and restarts.
At the restart, before anything else runs, it removes:

- every organization and its Microsoft sign-in tokens
- provider settings and API keys, connector settings and secrets, including
  the WhatsApp Web session
- chats, workspaces, the Graph cache, change history and run history
- Agent Team data, Nova notes and follow-ups
- installed agents, downloaded agent updates and the registry cache
- the configuration audit log on this device, with its integrity anchor
- logs

In an installed build it also removes the per-user files outside the data
folder:

- **macOS:** the Keychain item `OpenAdminOS Safe Storage` (account
  `OpenAdminOS`), the scheduler
  LaunchAgent, cached app updates (`~/Library/Caches/@openadminosdesktop-updater`,
  `~/Library/Caches/com.openadminos.desktop.ShipIt`), the app's caches,
  HTTP storage, saved window state and preferences
- **Windows:** the `OpenAdminOS Scheduler` scheduled task and cached app
  updates (`%LOCALAPPDATA%\@openadminosdesktop-updater`). The encryption key
  is in the data folder, so it goes with it.
- **Linux:** cached app updates (`~/.cache/@openadminosdesktop-updater`)

OpenAdminOS then opens at first run, with a notice that lists anything it could
not remove. Nothing outside these paths is touched.

What stays:

- The IT policy file `policy.json` set by whoever manages the device, both the
  machine file and the one in the data folder. If the one in the data folder
  is a link, a folder or anything else than a plain file, the reset stops
  before removing anything and says so: place the file itself there, or use the machine-wide policy path.
- Exports and other files you saved outside the data folder.
- The enterprise application and admin consent in each tenant.

A few details:

- The reset waits while any run is still going, read-only ones included,
  since a run can send to Teams or another connector. Let it finish, or
  cancel it in Runs, then reset. Once the reset starts, connector sends are
  declined.
- If some files in the data folder cannot be removed, for example because a
  backup or antivirus scan holds them, OpenAdminOS does not open. It shows
  **Reset did not finish** with the files that are left. Close the program
  that holds them and choose **Try again**, or remove them from the data folder
  yourself and choose **Try again**.
- A development build (`npm run dev`) resets the folder in
  `OPENADMINOS_USER_DATA_DIR` when that is set, otherwise the default data
  folder, which the installed app uses too. It never touches the Keychain
  item, the scheduler or the installed app's caches: development builds use
  Chromium's mock keychain on macOS. A reset requested in the installed app is
  finished only by the installed app; a development build that opens the same
  folder first shows **Reset did not finish** and leaves it alone.

## Before removing files by hand

Removing folders by hand skips the checks the in-app reset makes. Check first,
and stop if any of these applies:

- The data folder or a cache folder is a link, or something is mounted at it
  or inside it. Removing through it would delete files wherever it points.
  On macOS check with `ls -ld <folder>` and `mount | grep -i openadmin`. On
  Linux check with `ls -ld <folder>` and the command below, which lists
  every mount at or inside the folder (`findmnt` writes a space in a path as
  `\x20`, so the targets are decoded first). Continue only when it prints
  "No mount found". Unmount first, or remove only the link itself.

  ```bash
  if folder="$(realpath ~/.config/OpenAdminOS)" && mounts="$(findmnt -rno TARGET)"; then
    printf '%s\n' "$mounts" | while IFS= read -r target; do printf '%b\n' "$target"; done |
      grep -F -- "$folder" && echo "STOP: a mount is at or inside $folder" || echo "No mount found. You can continue."
  else
    echo "STOP: the check did not run"
  fi
  ```

  Run it again with `~/.cache/@openadminosdesktop-updater` for the cache
  folder. The Windows script below checks for links.
- `policy.json` in the data folder is a link (`ls -l` shows an arrow; on
  Windows the script stops on it). Removing the other files can break the IT
  policy; ask whoever manages the device first.

## Uninstall on macOS

1. Reset OpenAdminOS in the app as described above, then quit it, including
   the menu bar companion.
2. Drag OpenAdminOS from Applications to the Bin.

To remove everything by hand instead, make the checks in
[Before removing files by hand](#before-removing-files-by-hand), quit
OpenAdminOS and run these commands in Terminal before you install or open it
again. Delete the Keychain item
before the next launch: a new install that finds the old key can read any
token files that are still there.

```bash
# Repeat until it reports that the item could not be found.
security delete-generic-password -s "OpenAdminOS Safe Storage" -a OpenAdminOS
launchctl bootout "gui/$(id -u)/com.openadminos.scheduler"
rm -f ~/Library/LaunchAgents/com.openadminos.scheduler.plist
defaults delete com.openadminos.desktop
rm -rf ~/Library/Caches/@openadminosdesktop-updater \
  ~/Library/Caches/com.openadminos.desktop \
  ~/Library/Caches/com.openadminos.desktop.ShipIt \
  ~/Library/HTTPStorages/com.openadminos.desktop \
  ~/Library/HTTPStorages/com.openadminos.desktop.binarycookies \
  "$HOME/Library/Saved Application State/com.openadminos.desktop.savedState"
```

Then empty the data folder, keeping the IT policy file if there is one:

```bash
find "$HOME/Library/Application Support/OpenAdminOS" -mindepth 1 -maxdepth 1 ! -iname policy.json -exec rm -rf {} +
```

If no one manages the device, you can remove the whole folder instead. If
`ls -ld` shows the folder as a link (an arrow to another place), remove only
the link with `rm`, without a trailing slash, and check the folder it points
to before removing anything there.

Commands that report that an item does not exist can be ignored. Turn off
**OpenAdminOS Menu Bar Helper** in **System Settings > General > Login Items**
if it is still listed.

## Uninstall on Windows

1. Reset OpenAdminOS in the app as described above, then quit it.
2. Open **Settings > Apps > Installed apps**, select OpenAdminOS and choose
   **Uninstall**.

The uninstaller removes the app but keeps its data, and an update never
removes it. To remove everything by hand instead, make the checks in
[Before removing files by hand](#before-removing-files-by-hand) and quit
OpenAdminOS.

The scheduled task has the same name for every account on the machine. Check
whose it is first, and delete it only if **Run As User** is your account:

```powershell
schtasks /Query /TN "OpenAdminOS Scheduler" /V /FO LIST
schtasks /Delete /TN "OpenAdminOS Scheduler" /F
```

Then run this in PowerShell:

```powershell
# Removes a folder's contents without following links: a junction or
# symbolic link is removed as a link, never entered.
function Remove-OpenAdminOSContents([string]$Path, [string[]]$Keep = @()) {
  Get-ChildItem -LiteralPath $Path -Force | Where-Object { $Keep -notcontains $_.Name } | ForEach-Object {
    if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($_.PSIsContainer) { [IO.Directory]::Delete($_.FullName, $false) } else { Remove-Item -LiteralPath $_.FullName -Force }
    } elseif ($_.PSIsContainer) {
      Remove-OpenAdminOSContents $_.FullName
      Remove-Item -LiteralPath $_.FullName -Force
    } else {
      Remove-Item -LiteralPath $_.FullName -Force
    }
  }
}

$data = "$env:APPDATA\OpenAdminOS"
$cache = "$env:LOCALAPPDATA\@openadminosdesktop-updater"
$policy = Get-Item -LiteralPath "$data\policy.json" -Force -ErrorAction SilentlyContinue
if ($policy -and ($policy.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  "policy.json is a link to $($policy.Target). Ask whoever manages this device before removing anything."
} elseif ($policy -and $policy.PSIsContainer) {
  "policy.json is a folder, not the IT policy file. Move it out of the data folder, then run this again."
} else {
  foreach ($folder in @($data, $cache)) {
    $item = Get-Item -LiteralPath $folder -Force -ErrorAction SilentlyContinue
    if (-not $item) { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      "$folder is a link to $($item.Target). Check that folder before removing anything in it."
    } elseif ($folder -eq $data) {
      Remove-OpenAdminOSContents $folder -Keep @("policy.json")
    } else {
      Remove-OpenAdminOSContents $folder
    }
  }
}
```

The script keeps `policy.json`, the IT policy file, and stops when it is a
link or a folder. It stops at a data or cache folder that is a junction or link, because
removing through it would delete files wherever it points, and it removes
links inside the folders as links, without entering them. If no one manages
the device and the folder is not a link, you can remove the whole
`%APPDATA%\OpenAdminOS` folder. The encryption key that protects the sign-ins
is in that folder (`Local State`), so removing the folder also makes any
copied token files unreadable.

## Uninstall on Linux

Remove the package (`sudo apt remove openadminos`, your package manager, or
the AppImage file). Then make the checks in
[Before removing files by hand](#before-removing-files-by-hand), empty the
data folder while keeping the IT policy file, and remove the update cache:

```bash
find ~/.config/OpenAdminOS -mindepth 1 -maxdepth 1 ! -iname policy.json -exec rm -rf {} +
rm -rf ~/.cache/@openadminosdesktop-updater
```

The key that protects the sign-ins is kept by your keyring (GNOME Keyring or KWallet). Neither the in-app reset nor
removing the package deletes it: remove the OpenAdminOS entry with your
keyring tool if you want it gone. Without the token files it protects nothing.

## Revoke access in Entra

A reset or uninstall only affects this device. The OpenAdminOS enterprise
application and the admin consent granted to it stay in each tenant, and other
admins in the tenant who use OpenAdminOS rely on the same enterprise
application. To revoke access, follow
[Disconnecting and revoking](../trust/authentication.md#disconnecting-and-revoking):
[Revoking the OpenAdminOS app](../trust/authentication.md#revoking-the-openadminos-app)
for the shared app, or
[Revoking your own app registration](../trust/authentication.md#revoking-your-own-app-registration)
if you connected with your own.
