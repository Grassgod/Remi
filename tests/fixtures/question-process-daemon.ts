import { DaemonProtocolClient, type DaemonProtocolLane } from '@multiremi/worker/daemon-protocol-client.js';
import { DaemonTaskDownlinks } from '@multiremi/worker/daemon-downlinks.js';
import { registerDaemonOfferHandler } from '@multiremi/worker/daemon-offers.js';
import { MultiremiDaemon, type MultiremiTaskProvider } from '@multiremi/worker/daemon.js';
import { DAEMON_MIN_CLI_VERSION } from '@multiremi/contracts/daemon-protocol.js';
import type { ElicitationCreateParams, ElicitationResult } from '@multiremi/contracts/acp-protocol.js';

// A real separate process, native socket and production provider callback wiring.
// Process-local nonce inventory is deliberately lost on SIGKILL.
const input = JSON.parse(process.argv[2]!);
const active = new Set<string>(input.mode === 'source' ? [input.attempt.id] : []);
const client = new DaemonProtocolClient({ serverUrl: input.serverUrl, token: 'callback-fixture',
  daemonId: 'daemon_decision_callback', cliVersion: DAEMON_MIN_CLI_VERSION });
const downlinks = new DaemonTaskDownlinks(client, () => input.rt);
const lane: DaemonProtocolLane = {
  runtime: () => ({ runtime_id: input.rt, provider: 'claude', max_concurrency: 1,
    active_task_ids: [...active], active_question_waits: downlinks.activeQuestionWaits() }),
  heartbeat: () => ({ active_task_count: active.size }), onHeartbeatAck: async () => {},
  probeUpgrade: async () => {}, onTerminal: async () => {},
  onStateChange: () => downlinks.connectionChanged(),
  onConnected: () => client.send({ t: 'runtime.ready', rt: input.rt,
    p: { active_task_ids: [...active], active_question_waits: downlinks.activeQuestionWaits() } }),
};
client.addLane(lane);
if (input.mode === 'consumer') registerDaemonOfferHandler(client, {
  runtimeId: () => input.rt, rejection: () => active.size ? 'capacity' : null,
  run: task => {
    active.add(task.id); downlinks.bindTurn(task);
    void (async () => {
      // This mock host actually executes the new provider prompt, then confirms
      // its input via the same production protocol used by the daemon.
      const provider = { async *sendStream(prompt: string) {
        if (!prompt.includes('已记录答案') || !prompt.includes('Paris')) throw new Error('continuation answer missing');
        if (task.sessionId || (task as unknown as { session_id?: string }).session_id) throw new Error('resume-unsafe original provider session was reused');
        // Bootstrap offers intentionally contain range hints. The host reads
        // real source context with the new attempt token before confirming it.
        const response = await fetch(`${input.serverUrl}/api/sessions/${task.issueSessionId}/messages?from=${task.input_from_seq}&to=${task.input_to_seq}`, {
          headers: { Authorization: `Bearer ${task.auth_token}` },
        });
        if (!response.ok) throw new Error(`continuation range read ${response.status}`);
        await response.json();
        console.log(JSON.stringify({ event: 'provider_executed', attempt_id: task.id, turn_id: task.turn_id, prompt }));
        yield { text: 'continued' };
      } };
      for await (const _ of provider.sendStream(task.prompt)) {}
      await downlinks.consumeTaskSteerMessages(task.id, []);
      console.log(JSON.stringify({ event: 'consumer_ack', attempt_id: task.id, turn_id: task.turn_id }));
      const receipt = await client.event({ t: 'turn.complete', rt: input.rt, seq: 1,
        p: { turn_id: task.turn_id, attempt_id: task.id, input_to_seq: task.input_to_seq,
          reply: { body_md: 'Continued original work using Paris', message_kind: 'final' } } });
      if (receipt.ok !== true) throw new Error(`continuation completion rejected: ${JSON.stringify(receipt)}`);
      console.log(JSON.stringify({ event: 'consumer_completed', attempt_id: task.id, turn_id: task.turn_id }));
    })().catch(error => { console.error(error); process.exit(2); });
  },
});
client.startLane(lane);
while (client.connectionState() !== 'connected') await Bun.sleep(5);
if (input.mode === 'source') {
  downlinks.bindTurn(input.offer);
  const daemon = Object.create(MultiremiDaemon.prototype);
  Object.assign(daemon, { options: { approvalMode: 'ask', humanRequestTimeoutMs: 120_000, runtimeId: input.rt },
    pollAbort: new AbortController(), ensureTrace: () => ({ append: () => {} }), taskDownlinks: downlinks });
  let question!: (params: ElicitationCreateParams) => Promise<ElicitationResult>;
  const provider = { setElicitationHandler: (handler: typeof question) => { question = handler; } } as MultiremiTaskProvider;
  daemon.attachHumanInputHandlers(provider, input.attempt, new AbortController().signal, () => 1);
  await question({ mode: 'form', sessionId: 'process-provider', message: 'Where?',
    requestedSchema: { type: 'object', properties: { answer: { type: 'string', title: 'Where?' } }, required: ['answer'] } });
  console.log(JSON.stringify({ event: 'old_provider_returned' }));
}
await new Promise(() => {});
