export class CDP {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener('message', event => {
      const data = JSON.parse(event.data);
      if (data.id) {
        const request = this.pending.get(data.id);
        if (request) { clearTimeout(request.timer); this.pending.delete(data.id); data.error ? request.reject(new Error(data.error.message)) : request.resolve(data.result); }
      } else for (const listener of this.listeners.get(data.method) ?? []) listener(data.params);
    });
    socket.addEventListener('close', () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP disconnected')); }
      this.pending.clear();
    });
  }
  static async connect(port = 19321) {
    let target;
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        target = targets.find(entry => entry.type === 'page' && entry.url.startsWith('https://lolka.app/'));
        if (target) break;
      } catch { /* Wait for test-only loopback listener. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!target) throw new Error('Lolka test page was not found');
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new CDP(socket);
  }
  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + result.result.description);
    return result.result.value;
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => this.listeners.get(method)?.delete(listener);
  }
  close() { this.socket.close(); }
}
