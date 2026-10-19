import type { QwenVoiceEvent } from './qwen-voice-session.ts';

export class QwenSignalingError extends Error {
  constructor(message: string, readonly retryable = true) { super(message); }
}

/** A logical call survives replacement of its provider's WebRTC session. */
export class QwenRealtimeTransport {
  private peer?: RTCPeerConnection;
  private sendChannel?: RTCDataChannel;
  private eventChannel?: RTCDataChannel;
  private controller?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private heartbeatDeadline?: ReturnType<typeof setTimeout>;
  private closed = false;
  private ready = false;
  private attempts = 0;

  constructor(private hooks: {
    track: MediaStreamTrack;
    config: () => unknown;
    negotiate: (sdp: string, signal: AbortSignal) => Promise<string>;
    event: (event: QwenVoiceEvent) => void;
    audio: (event: RTCTrackEvent) => void;
    ready: () => void;
    lost: () => void;
    status: (text: string) => void;
    fatal: (text: string) => void;
  }) {}

  start() {
    window.addEventListener('online', this.wake);
    window.addEventListener('offline', this.offline);
    window.addEventListener('focus', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    void this.connect();
  }

  send(event: unknown) {
    if (this.closed || !this.ready) return;
    try {
      if (this.sendChannel?.readyState !== 'open') throw new Error('语音事件通道已关闭');
      this.sendChannel.send(JSON.stringify(event));
    } catch { this.recover('语音事件发送失败'); }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.disposePeer();
    window.removeEventListener('online', this.wake);
    window.removeEventListener('offline', this.offline);
    window.removeEventListener('focus', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
  }

  private offline = () => this.recover('网络已离线');
  private wake = () => {
    if (this.closed || navigator.onLine === false || document.visibilityState === 'hidden') return;
    if (this.ready) { this.ping(); return; }
    if (this.peer) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    void this.connect();
  };

  private disposePeer() {
    this.ready = false;
    clearTimeout(this.deadline);
    clearInterval(this.heartbeat);
    clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = undefined;
    this.controller?.abort();
    this.controller = undefined;
    const peer = this.peer;
    this.peer = undefined; // Ignore callbacks from the retired session, including close events.
    this.sendChannel?.close();
    this.eventChannel?.close();
    this.sendChannel = this.eventChannel = undefined;
    peer?.close();
  }

  private recover(reason: string) {
    if (this.closed || this.retryTimer !== undefined) return;
    this.disposePeer();
    this.hooks.lost();
    if (navigator.onLine === false) {
      this.hooks.status('网络已离线，恢复后自动重连；任务继续运行');
      return;
    }
    this.attempts += 1;
    this.hooks.status(`语音连接恢复中…（第 ${this.attempts} 次）`);
    console.info('[Qwen voice] reconnect:', reason);
    // Keep retrying while the user keeps the call open, with bounded request rate.
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts - 1, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect();
    }, delay);
  }

  private ping = () => {
    if (!this.ready || this.heartbeatDeadline !== undefined) return;
    // An empty partial update returns the current configuration. In particular,
    // Audio 3.0 rejects resending turn_detection after audio has begun, even when
    // its value is unchanged. Do not mutate configuration for a heartbeat.
    this.heartbeatDeadline = setTimeout(() => this.recover('语音服务未响应连接检查'), 15_000);
    this.send({ type: 'session.update', session: {} });
  };

  private async connect() {
    if (this.closed || this.peer) return;
    if (navigator.onLine === false) { this.recover('网络已离线'); return; }
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => !this.closed && this.peer === peer;
    let created = false;
    let configured = false;
    let attaching = false;
    const sender = peer.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    const channel = peer.createDataChannel('oai-events');
    this.sendChannel = channel;
    const initialize = () => {
      if (!current() || !created || configured || channel.readyState !== 'open') return;
      configured = true;
      this.hooks.status(this.attempts ? '正在恢复语音模型…' : '正在初始化语音模型…');
      channel.send(JSON.stringify({ type: 'session.update', session: this.hooks.config() }));
    };
    channel.onopen = initialize;
    channel.onclose = channel.onerror = () => { if (current()) this.recover('语音发送通道中断'); };
    peer.ondatachannel = event => {
      if (!current()) return;
      this.eventChannel = event.channel;
      event.channel.onclose = event.channel.onerror = () => { if (current()) this.recover('语音接收通道中断'); };
      event.channel.onmessage = message => {
        if (!current()) return;
        let data: QwenVoiceEvent;
        try { data = JSON.parse(String(message.data)); } catch { return; }
        if (data.type === 'session.created') { created = true; initialize(); return; }
        if (data.type === 'session.updated') {
          clearTimeout(this.heartbeatDeadline);
          this.heartbeatDeadline = undefined;
          if (!configured || this.ready || attaching) return;
          attaching = true;
          void sender.replaceTrack(this.hooks.track).then(() => {
            if (!current()) return;
            this.ready = true;
            this.attempts = 0;
            clearTimeout(this.deadline);
            this.heartbeat = setInterval(this.ping, 30_000);
            this.hooks.ready();
          }).catch(() => { if (current()) this.recover('麦克风音轨连接失败'); });
          return;
        }
        if (data.type === 'session.finished' || (data.type === 'error' && data.error?.type === 'server_error')) {
          this.recover(data.error?.message || '语音服务会话已结束');
          return;
        }
        this.hooks.event(data);
      };
    };
    peer.ontrack = event => { if (current()) this.hooks.audio(event); };
    peer.onconnectionstatechange = () => {
      if (current() && ['failed', 'disconnected', 'closed'].includes(peer.connectionState)) this.recover(`WebRTC ${peer.connectionState}`);
    };
    this.deadline = setTimeout(() => { if (current()) this.recover('语音连接建立超时'); }, 30_000);
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (!current()) return;
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
        const abort = () => reject(new Error('连接已取消'));
        controller.signal.addEventListener('abort', abort, { once: true });
        peer.onicegatheringstatechange = () => {
          if (peer.iceGatheringState !== 'complete') return;
          controller.signal.removeEventListener('abort', abort);
          resolve();
        };
      });
      if (!current()) return;
      const sdp = await this.hooks.negotiate(peer.localDescription?.sdp || '', controller.signal);
      if (current()) await peer.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      if (!current()) return;
      if (error instanceof QwenSignalingError && !error.retryable) {
        this.close(); this.hooks.lost(); this.hooks.fatal(error.message);
      } else this.recover(error instanceof Error ? error.message : '语音连接失败');
    }
  }
}
