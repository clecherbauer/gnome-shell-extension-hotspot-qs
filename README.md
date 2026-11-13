# Hotspot Quick Toggle

GNOME Shell extension that adds a **Hotspot** toggle to Quick Settings.
It turns a NetworkManager Wi-Fi hotspot on and off (`nmcli device wifi hotspot`),
handy for sharing a wired connection with your phone.

The toggle's menu shows, while the hotspot is on:

- network name
- password (hidden, click to copy)
- connected devices (IP and MAC)
- a QR code to join from a phone

Supports GNOME Shell 46.

## Install

```sh
git clone https://github.com/clecherbauer/gnome-shell-extension-hotspot-qs.git
cp -r gnome-shell-extension-hotspot-qs ~/.local/share/gnome-shell/extensions/hotspot-qs@clecherbauer.github.io
gnome-extensions enable hotspot-qs@clecherbauer.github.io
```

Then restart GNOME Shell (X11: Alt+F2, `r`; Wayland: log out and in).

The QR code needs `qrencode` (`sudo apt install qrencode`). Without it the menu says so.
The QR code part is not tested yet.

## Notes

- Device names are not shown: they live in a root-only dnsmasq lease file.
- The password is passed to `qrencode` via stdin, not on the command line.
