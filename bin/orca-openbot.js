#!/usr/bin/env node
// orca-openbot: CLI of the bridge between Pi (Gentle Shell in Orca) and OpenBot. Stdout is JSON
// (except --help). Exit: 0 ok, 1 doctor found failures, 2 webhook not
// configured, 4 invalid arguments, 5 order/webhook error.
// removed: hook, watch and read commands (plan-orca-openbot §2/§3).
import { runFlush } from '../events/flush.js';
import { runIngest } from '../events/ingest.js';
import { sendToPane } from '../control/send.js';
import { status, testEvent, doctor, VERSION } from '../control/diagnostics.js';
import { CliError, EXIT, invalid } from '../control/errors.js';

const USAGE = `Usage: orca-openbot <status|send|test-event|doctor>

  status                                   redacted config, detection, queue
  send --pane orca:ID --event-id UUID --text TEXT
                                           order via the Pi extension, waits for its ack; delivered: bridge
  test-event [--state done|blocked|question|error] [--workspace NAME] [--event-id UUID]
                                           send 1 signed orca.test event; return machine metadata
                                           (--workspace picks the OPENBOT_ORCA_ROUTES route and its secret;
                                           --event-id reuses a delivery id, so a repeat is a duplicate)
  doctor [--json]                          offline check (never sends): config, permissions, secret format,
                                           local signature, last rejected delivery (401 fail, 413 warn),
                                           live Pi extension per pane. JSON adds checks, bridge[]
                                           (with pi_extension version/commit or unknown), plugin_version,
                                           machine_label and machine_label_source (config|hostname).
                                           Also lists live panes with no enqueued event in the last
                                           OPENBOT_ORCA_QUIET_MINUTES (default 60); JSON: quiet_panes[].

Internal: flush (deliver the queue), ingest --pane ID (consume complete Pi JSONL records, flag a stalled turn after
OPENBOT_ORCA_STALLED_MINUTES, default 15; quiet success).

Values that start with -- must be passed as --flag=VALUE (e.g. --text=--help).

Config: OPENBOT_ORCA_WEBHOOK_URL, OPENBOT_ORCA_WEBHOOK_SECRET (whsec_...; required with each URL),
OPENBOT_ORCA_MACHINE_LABEL, OPENBOT_ORCA_TIMEOUT_MS, OPENBOT_ORCA_ROUTES in the environment or private config.env.
Each OPENBOT_ORCA_* name still reads the old OPENBOT_HERDR_* name when it is unset (one release).
OPENBOT_ORCA_ROUTES: optional PREFIX:NAME list (e.g. alan-:ALAN,ubu-:UBU); an event goes to the first
route whose prefix starts its workspace name, using OPENBOT_ORCA_WEBHOOK_URL_<NAME>/OPENBOT_ORCA_WEBHOOK_SECRET_<NAME>;
no match uses OPENBOT_ORCA_WEBHOOK_URL if set, else the event is dropped. Unset: single webhook.
OPENBOT_ORCA_MACHINE_LABEL: optional non-secret label; overrides hostname (source config|hostname).
OPENBOT_ORCA_TIMEOUT_MS: positive finite integer milliseconds (default 30000; env wins).
OPENBOT_ORCA_ORDER_ACK_MS: wait for an order ack in ms (default 20000; environment only).
OPENBOT_ORCA_CONTEXT_INFO_PERCENT/OPENBOT_ORCA_CONTEXT_WARN_PERCENT: environment only, read by
the Pi extension (default 50/80; 0 < info < warn <= 100, else both defaults apply).
attention_kind also includes cache_miss (estimated re-billed tokens/cost) and
context (estimated ctx% threshold crossing), both from the Pi extension only,
each carrying an optional estimated telemetry object.
Synthetic event results/errors include machine_label, host, os, plugin_version
(unset synthetic label uses hostname).
Webhook payloads put attention_kind/summary first, then at most 5 error lines,
and neutral next_hint read/reply templates.
test-event results/errors include elapsedMs/timeoutMs; a timeout, HTTP or network error exits 5.
`;

const SPEC = {
  ingest: { values: ['--pane'], flags: [] },
  flush: { values: [], flags: [] },
  status: { values: [], flags: [] },
  send: { values: ['--pane', '--text', '--event-id'], flags: [] },
  'test-event': { values: ['--state', '--workspace', '--event-id'], flags: [] },
  doctor: { values: [], flags: ['--json'] },
};

function parseArgs(cmd, argv) {
  const spec = SPEC[cmd];
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let value;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (spec.flags.includes(arg) && value === undefined) {
      out[arg] = true;
    } else if (spec.values.includes(arg)) {
      if (value === undefined) {
        // A following option means the value was omitted; use --text=--foo for dash-leading text.
        if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) {
          throw invalid(arg + ' requires a value (use ' + arg + '=VALUE for values starting with --)');
        }
        value = argv[(i += 1)];
      }
      out[arg] = value;
    } else {
      throw invalid('unknown ' + cmd + ' argument: ' + arg);
    }
  }
  return out;
}

const print = (obj) => process.stdout.write(JSON.stringify(obj, null, 2) + '\n');

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE);
    return cmd ? EXIT.ok : EXIT.invalid;
  }
  if (cmd === '--version') {
    print({ ok: true, version: VERSION });
    return EXIT.ok;
  }
  if (!SPEC[cmd]) throw invalid('unknown command: ' + cmd + ' (see orca-openbot --help)');
  const a = parseArgs(cmd, rest);
  switch (cmd) {
    case 'flush':
      try {
        await runFlush();
      } catch {
        // a flush never fails its caller
      }
      return EXIT.ok;
    case 'ingest':
      runIngest({ paneId: a['--pane'] });
      return EXIT.ok;
    case 'status':
      print(status());
      return EXIT.ok;
    case 'send':
      print(sendToPane({ paneId: a['--pane'], text: a['--text'] ?? null, eventId: a['--event-id'] ?? null }));
      return EXIT.ok;
    case 'test-event':
      print(await testEvent({ state: a['--state'] ?? 'done', workspace: a['--workspace'] ?? null, eventId: a['--event-id'] ?? null }));
      return EXIT.ok;
    case 'doctor': {
      const result = await doctor({ json: Boolean(a['--json']) });
      print(result);
      return result.ok ? EXIT.ok : EXIT.doctor;
    }
    default:
      throw invalid('unknown command: ' + cmd);
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof CliError) {
    print(err.body);
    process.exitCode = err.exitCode;
  } else {
    print({ ok: false, reason: 'internal_error', message: err?.message || String(err) });
    process.exitCode = EXIT.failed;
  }
}
