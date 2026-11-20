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
  machine file and the one in the data folder.
- Exports and other files you saved outside the data folder.
- The enterprise application and admin consent in each tenant.

A few details:

- The reset waits while a confirmed change is being applied. Let the run
  finish, then reset.
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

## Uninstall on macOS

1. Reset OpenAdminOS in the app as described above, then quit it, including
   the menu bar companion.
2. Drag OpenAdminOS from Applications to the Bin.

To remove everything by hand instead, quit OpenAdminOS and run these commands
in Terminal before you install or open it again. Delete the Keychain item
before the next launch: a new install that finds the old key can read any
token files that are still there.

```bash
security delete-generic-password -s "OpenAdminOS Safe Storage" -a OpenAdminOS
launchctl bootout "gui/$(id -u)" ~/Library/LaunchAgents/com.openadminos.scheduler.plist
rm -f ~/Library/LaunchAgents/com.openadminos.scheduler.plist
defaults delete com.openadminos.desktop
rm -rf ~/Library/Caches/@openadminosdesktop-updater \
  ~/Library/Caches/com.openadminos.desktop \
  ~/Library/Caches/com.openadminos.desktop.ShipIt \
  ~/Library/HTTPStorages/com.openadminos.desktop \
  ~/Library/HTTPStorages/com.openadminos.desktop.binarycookies \
  "$HOME/Library/Saved Application State/com.openadminos.desktop.savedState"
```

Then remove the data folder `~/Library/Application Support/OpenAdminOS`. If
your device is managed and the folder holds `policy.json`, remove everything
except that file. Commands that report that an item does not exist can be
ignored. Turn off **OpenAdminOS Menu Bar Helper** in **System Settings >
General > Login Items** if it is still listed.

## Uninstall on Windows

1. Reset OpenAdminOS in the app as described above, then quit it.
2. Open **Settings > Apps > Installed apps**, select OpenAdminOS and choose
   **Uninstall**.

The uninstaller removes the app but keeps its data, and an update never
removes it. To remove everything by hand instead, quit OpenAdminOS and run
this in PowerShell:

```powershell
schtasks /Delete /TN "OpenAdminOS Scheduler" /F
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\@openadminosdesktop-updater"
Get-ChildItem "$env:APPDATA\OpenAdminOS" -Exclude policy.json | Remove-Item -Recurse -Force
```

The last line keeps `policy.json`, the IT policy file. If no one manages the
device, you can remove the whole `%APPDATA%\OpenAdminOS` folder. The
encryption key that protects the sign-ins is in that folder (`Local State`),
so removing the folder also makes any copied token files unreadable.

## Uninstall on Linux

Remove the package (`sudo apt remove openadminos`, your package manager, or
the AppImage file), then remove `~/.config/OpenAdminOS` and
`~/.cache/@openadminosdesktop-updater`. The key that protects the sign-ins is
kept by your keyring (GNOME Keyring or KWallet). Neither the in-app reset nor
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
