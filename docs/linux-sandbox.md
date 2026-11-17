# Turning the sandbox back on, on Linux

IncarnaMind runs an Analysis in Chromium's sandbox, the one the rest of the app runs in. It has no access to your files or the network, so an Analysis can't run while the app runs without it. Where the Analysis would have appeared, the app says "Analyses need the app’s sandbox, which is off", and the rest of the app works as usual.

Without the sandbox the whole app is less safe, not only Analyses. So the app also says "Running without the app’s sandbox" at the foot of the sidebar when it first starts that way, and in Settings › Privacy for as long as it does. Both link to this page.

## Why it is off

Ubuntu 23.10 and later, including 24.04, have an AppArmor rule that refuses unprivileged user namespaces to programs without a profile that allows them. Chromium's sandbox needs them. The AppImage checks for this when it starts, and if the rule is in the way it starts the app with the sandbox off, without saying so. Starting the app with `--no-sandbox` turns it off the same way.

## The fix: install the .deb

Download the `.deb` for your version from the [releases page](https://github.com/IncarnaMind/IncarnaMind/releases) and install it:

```sh
sudo apt install ./IncarnaMind_*_amd64.deb
```

The .deb installs an AppArmor profile that allows user namespaces for IncarnaMind's own install path, so the sandbox works with no further step. Then start IncarnaMind from your applications, not the AppImage, and without `--no-sandbox`.

## The last resort: allow user namespaces for every program

Use this only if you can't install the .deb. It lifts the rule for the whole system, not just for IncarnaMind: any program can create user namespaces again, and attacks on the kernel often use them, which is why Ubuntu added the rule. The AppImage then starts with its sandbox on.

```sh
sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
```

The setting lasts until you restart the computer. To keep it after that, put `kernel.apparmor_restrict_unprivileged_userns=0` in a file in `/etc/sysctl.d/`.

## Code on whole files and Skill scripts

When the assistant analyses whole files (Python or a shell command on copies of your Documents) or runs a Skill's script, the code runs in a second sandbox, the operating system's own: bubblewrap. It needs three packages:

```sh
sudo apt install bubblewrap socat ripgrep      # Debian, Ubuntu
sudo dnf install bubblewrap socat ripgrep      # Fedora
sudo pacman -S bubblewrap socat ripgrep        # Arch
```

Then restart IncarnaMind. Settings › Skills says when this sandbox can't start, and why. Until it can, the assistant analyses only in the app's own sandbox, on the rows IncarnaMind has read, and each Skill script asks before it runs, with no sandbox.

On Ubuntu 23.10 and later, the AppArmor rule above can stop bubblewrap from starting a sandbox even when all three packages are installed; Settings then says this computer doesn't let IncarnaMind start one. The last resort above lifts that rule.
