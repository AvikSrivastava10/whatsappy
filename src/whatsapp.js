import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import pino from 'pino';
import qr from 'qrcode-terminal';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class WhatsApp {
  constructor(directory, { interactive = false, phone = null, report = () => {} } = {}) {
    this.directory = directory;
    this.interactive = interactive;
    this.phone = phone;
    this.report = report;
    this.connected = false;
    this.stopped = false;
    this.retries = 0;
    this.pairingRequested = false;
    this.saves = Promise.resolve();
  }
  ready() { return this.connected && !this.stopped; }
  async start() {
    if (!this.interactive && !existsSync(join(this.directory, 'creds.json'))) throw new Error('WhatsApp is not linked. Run npm run bot -- link first.');
    await this.connect();
  }
  async connect() {
    if (this.stopped) return;
    const { state, saveCreds } = await useMultiFileAuthState(this.directory);
    if (this.stopped) return;
    const sock = makeWASocket({
      auth: state, logger: pino({ level: 'silent' }), browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false, syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      connectTimeoutMs: 30_000, defaultQueryTimeoutMs: 30_000
    });
    this.socket = sock;
    // Serialize credential writes so events cannot overwrite newer state out of order.
    sock.ev.on('creds.update', () => {
      this.saves = this.saves.then(saveCreds).catch(() => { this.report('auth_save_failed'); this.stop(); });
    });
    sock.ev.on('connection.update', update => {
      if (this.stopped || this.socket !== sock) return;
      if (update.qr && !this.interactive) {
        this.report('relink_required'); this.stop(); return;
      }
      if (update.qr && this.interactive && !this.phone) {
        console.log('Scan this QR using WhatsApp > Linked devices > Link a device.');
        qr.generate(update.qr, { small: true });
      }
      if (update.qr && this.interactive && this.phone && !this.pairingRequested) {
        this.pairingRequested = true;
        sock.requestPairingCode(this.phone).then(code => console.log(`Pairing code: ${code}`)).catch(() => {
          this.report('pairing_failed_restart_link'); this.stop();
        });
      }
      if (update.connection === 'open') {
        this.connected = true; this.retries = 0; this.report('connected');
      }
      if (update.connection === 'close') {
        this.connected = false;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if ([DisconnectReason.loggedOut, DisconnectReason.badSession, DisconnectReason.connectionReplaced, DisconnectReason.forbidden].includes(code)) {
          this.report('relink_required'); this.stopped = true; return;
        }
        this.report('disconnected_retrying');
        const wait = code === DisconnectReason.restartRequired ? 1000 : Math.min(60_000, 1000 * 2 ** Math.min(this.retries++, 6));
        this.timer = setTimeout(() => this.connect().catch(() => { this.report('connection_failed_restart_service'); this.stop(); }), wait);
      }
    });
  }
  async waitReady(timeout = 120_000) {
    const until = Date.now() + timeout;
    while (!this.ready()) {
      if (this.stopped || Date.now() > until) throw new Error('WhatsApp did not connect; inspect local status and relink if needed');
      await new Promise(r => setTimeout(r, 250));
    }
  }
  async groups() {
    await this.waitReady();
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({ id: g.id, name: g.subject }));
  }
  async send(group, payload) {
    if (!this.ready()) throw Object.assign(new Error('Not connected'), { safeToRetry: true });
    // After this point, errors are ambiguous; the dispatcher must not blindly retry.
    let timer;
    try {
      const result = await Promise.race([
        this.socket.sendMessage(group, payload),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Send timed out')), 45_000); })
      ]);
      return result?.key?.id;
    } finally { clearTimeout(timer); }
  }
  stop() {
    this.stopped = true; this.connected = false; clearTimeout(this.timer);
    this.socket?.end(new Error('Local shutdown'));
  }
  async flush() { await this.saves; }
}
