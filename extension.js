import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import NM from 'gi://NM';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const ICON = 'network-wireless-hotspot-symbolic';
const log = m => console.log(`[hotspot-qs] ${m}`);

// Runs argv, resolves to stdout on success, null on failure.
function run(argv) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (p, res) => {
                try {
                    const [, stdout, stderr] = p.communicate_utf8_finish(res);
                    if (!p.get_successful())
                        log(`${argv.join(' ')} failed: ${stderr}`);
                    resolve(p.get_successful() ? stdout : null);
                } catch (e) {
                    log(e); resolve(null);
                }
            });
        } catch (e) {
            log(e); resolve(null);
        }
    });
}

// The active connection running in AP mode, or null.
function activeHotspot(client) {
    for (const ac of client?.get_active_connections() ?? []) {
        if (ac.get_connection()?.get_setting_wireless()?.get_mode() === 'ap')
            return ac;
    }
    return null;
}

// PNG bytes of a QR code for text, or null (e.g. qrencode not installed).
// Text goes in via stdin so the password never shows up in a process list.
function qrPng(text) {
    return new Promise(resolve => {
        try {
            const proc = Gio.Subprocess.new(['qrencode', '-t', 'PNG', '-s', '5', '-m', '2', '-o', '-'],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_async(new GLib.Bytes(new TextEncoder().encode(text)), null, (p, res) => {
                try {
                    const [, stdout] = p.communicate_finish(res);
                    resolve(p.get_successful() ? stdout : null);
                } catch (e) {
                    log(e); resolve(null);
                }
            });
        } catch (e) {
            resolve(null); // qrencode missing
        }
    });
}

// Wi-Fi QR payload as phones expect it (same format as GNOME Settings).
function wifiQrText(ssid, psk) {
    const esc = s => s.replace(/([\\;,:"])/g, '\\$1');
    return psk ? `WIFI:T:WPA;S:${esc(ssid)};P:${esc(psk)};;` : `WIFI:T:nopass;S:${esc(ssid)};;`;
}

function getPsk(conn) {
    return new Promise(resolve => {
        conn.get_secrets_async('802-11-wireless-security', null, (c, res) => {
            try {
                resolve(c.get_secrets_finish(res).recursiveUnpack()['802-11-wireless-security']?.psk ?? null);
            } catch (e) {
                log(e); resolve(null);
            }
        });
    });
}

const HotspotToggle = GObject.registerClass(
class HotspotToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({title: 'Hotspot', iconName: ICON});
        this._client = null;
        this._busy = false;
        this._psk = null;

        this.menu.setHeader(ICON, 'Hotspot');
        this._details = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._details);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addSettingsAction('Wi-Fi Settings', 'gnome-wifi-panel.desktop');
        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._fillDetails().catch(log);
        });

        this.connect('clicked', () => this._toggle().catch(log));
        NM.Client.new_async(null, (_o, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                log(e); return;
            }
            if (this._destroyed)
                return;
            this._acId = this._client.connect('notify::active-connections', () => this._sync());
            this._sync();
        });
    }

    _sync() {
        const ac = activeHotspot(this._client);
        this.checked = ac !== null;
        this.subtitle = ac?.get_id() ?? null;
        this.menu.setHeader(ICON, 'Hotspot', ac ? 'On' : 'Off');
    }

    _addInfo(text, onActivate = null) {
        const item = new PopupMenu.PopupMenuItem(text, {reactive: !!onActivate});
        if (onActivate)
            item.connect('activate', onActivate);
        this._details.addMenuItem(item);
        return item;
    }

    async _fillDetails() {
        this._details.removeAll();
        const ac = activeHotspot(this._client);
        if (!ac) {
            this._addInfo('Hotspot is off');
            return;
        }
        const conn = ac.get_connection();
        const ssid = conn.get_setting_wireless()?.get_ssid();
        const iface = ac.get_devices()[0]?.get_iface();
        const name = ssid ? NM.utils_ssid_to_utf8(ssid.get_data()) : ac.get_id();
        this._addInfo(`Network: ${name}`);

        // Password stays hidden on screen; click copies it.
        const pwItem = this._addInfo('Password: ••••••••  (click to copy)', () => {
            if (this._psk)
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._psk);
        });
        this._psk = await getPsk(conn);
        if (!this._psk)
            pwItem.label.text = 'Password: unavailable';

        // ponytail: IP+MAC only, hostnames sit in a root-only dnsmasq lease file
        const neigh = iface ? await run(['ip', 'neigh', 'show', 'dev', iface]) : null;
        const clients = (neigh ?? '').split('\n')
            .filter(l => /REACHABLE|STALE|DELAY|PROBE/.test(l))
            .map(l => l.split(' '))
            .map(f => `${f[0]}  ${f[f.indexOf('lladdr') + 1] ?? ''}`);
        if (!this.menu.isOpen)
            return;
        this._addInfo(`Connected devices: ${clients.length}`);
        clients.forEach(c => this._addInfo(`   ${c}`));

        const png = await qrPng(wifiQrText(name, this._psk));
        if (!this.menu.isOpen)
            return;
        if (!png) {
            this._addInfo('QR code: install qrencode');
            return;
        }
        const qrItem = new PopupMenu.PopupBaseMenuItem({reactive: false});
        qrItem.add_child(new St.Icon({gicon: Gio.BytesIcon.new(png), icon_size: 180, x_expand: true}));
        this._details.addMenuItem(qrItem);
    }

    async _toggle() {
        if (this._busy || !this._client)
            return;
        this._busy = true;
        try {
            const ac = activeHotspot(this._client);
            if (ac)
                await run(['nmcli', 'connection', 'down', ac.get_uuid()]);
            else if (await run(['nmcli', 'radio', 'wifi', 'on']) !== null)
                await run(['nmcli', 'device', 'wifi', 'hotspot']);
        } finally {
            this._busy = false;
            this._sync();
        }
    }

    destroy() {
        this._destroyed = true;
        this._psk = null;
        if (this._acId)
            this._client.disconnect(this._acId);
        super.destroy();
    }
});

const HotspotIndicator = GObject.registerClass(
class HotspotIndicator extends QuickSettings.SystemIndicator {});

export default class HotspotQuickToggleExtension extends Extension {
    enable() {
        // ponytail: everything guarded, a failure here must never break Quick Settings
        try {
            this._indicator = new HotspotIndicator();
            this._indicator.quickSettingsItems.push(new HotspotToggle());
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        } catch (e) {
            log(`enable failed: ${e}`);
            this.disable();
        }
    }

    disable() {
        this._indicator?.quickSettingsItems.forEach(i => i.destroy());
        this._indicator?.destroy();
        this._indicator = null;
    }
}
