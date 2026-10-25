# Turning the sandbox back on, on Linux

IncarnaMind runs an Analysis in a sandbox that has no access to your files or the network. That sandbox is Chromium's, the same one the rest of the app runs in, so an Analysis can't run while the app runs without it. Instead, the place where the Analysis would have appeared says "Analyses need the app's sandbox, which is off", and the rest of the app works as usual.

Without the sandbox the whole app is less safe, not only Analyses, so the app also says "Running without the app’s sandbox" at the foot of the sidebar when it first starts that way, and in Settings › Privacy for as long as it does. Both link to this page.

## Why it is off

Ubuntu 23.10 and later, including 24.04, have an AppArmor rule that refuses unprivileged user namespaces to programs without a profile that allows them. Chromium's sandbox needs them. The AppImage checks for this when it starts, and if the rule is in the way it starts the app with the sandbox off, without saying so. Starting the app with `--no-sandbox` turns it off the same way.

## The fix: install the .deb

Download the `.deb` for your version from the [releases page](https://github.com/IncarnaMind/IncarnaMind/releases) and install it:

```sh
sudo apt install ./IncarnaMind_*_amd64.deb
```

The .deb installs an AppArmor profile that allows user namespaces for IncarnaMind's own install path, so the sandbox works with no further step. Then start IncarnaMind from your applications, not the AppImage, and without `--no-sandbox`.

## The last resort: allow user namespaces for every program

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

This lifts the rule for the whole system, not just for IncarnaMind, and the AppImage then starts with its sandbox on. Any program can then create user namespaces again. Attacks on the kernel often use them, which is why Ubuntu added the rule. The setting lasts until you restart the computer. To keep it after that, put `kernel.apparmor_restrict_unprivileged_userns=0` in a file in `/etc/sysctl.d/`. Use this only if you can't install the .deb.
