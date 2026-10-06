const scope = self as unknown as Worker;

scope.onmessage = (event: MessageEvent) => {
  const { control, data, init } = event.data;
  const ctl = new Int32Array(control);
  const buf = new Uint8Array(data);
  const reply = (payload: unknown, notify: boolean) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    buf.set(bytes);
    Atomics.store(ctl, 1, bytes.length);
    Atomics.store(ctl, 0, 1);
    if (notify) Atomics.notify(ctl, 0);
  };
  if (init) {
    reply({ ok: true }, false);
    return;
  }
  // The previous response's notify arrives after the next request has reset
  // the condition to pending. Its buffer is still the previous response.
  setTimeout(() => Atomics.notify(ctl, 0), 10);
  setTimeout(() => reply({ rows: [{ value: 42 }], count: 1 }, true), 50);
};
