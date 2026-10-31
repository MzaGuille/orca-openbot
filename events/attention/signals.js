// removed: screen and Herdr hook signals (plan-orca-openbot §2: only pi-ext and osc).
// The sole attention signal registry. Higher priority wins; ties preserve entry order.
export const SIGNALS = [
  { id: 'pi-cache-miss', source: 'pi-ext', match: { name: 'cache_miss' },
    attention_kind: 'cache_miss', priority: 60, fixture: 'pi-cache-miss.json', description: 'Estimated incremental cache re-billing' },
  { id: 'pi-context-info', source: 'pi-ext', match: { name: 'context', 'telemetry.level': 'info' },
    attention_kind: 'context', priority: 50, fixture: 'pi-context-info.json', description: 'Context info threshold crossing' },
  { id: 'pi-context-warn', source: 'pi-ext', match: { name: 'context', 'telemetry.level': 'warn' },
    attention_kind: 'context', priority: 60, fixture: 'pi-context-warn.json', description: 'Context warning suggests /compact' },
  { id: 'pi-stalled', source: 'pi-ext', match: { name: 'stalled' },
    attention_kind: 'stalled', priority: 60, fixture: 'pi-stalled.json', description: 'Open turn with no tool or message activity while the heartbeat is alive' },
  {
    "id": "osc-question",
    "source": "osc",
    "match": {
      "name": "program_status",
      "status": "blocked",
      "kind": "question"
    },
    "attention_kind": "question",
    "priority": 80,
    "fixture": "osc-question.json",
    "description": "osc question"
  },
  {
    "id": "osc-permission",
    "source": "osc",
    "match": {
      "name": "program_status",
      "status": "blocked",
      "kind": [
        "permission",
        "auth"
      ]
    },
    "attention_kind": "blocked",
    "priority": 80,
    "fixture": "osc-permission.json",
    "description": "osc permission"
  },
  {
    "id": "osc-done",
    "source": "osc",
    "match": {
      "name": "program_status",
      "status": "done"
    },
    "attention_kind": "done",
    "priority": 10,
    "fixture": "osc-done.json",
    "description": "osc done"
  },
  {
    "id": "osc-error",
    "source": "osc",
    "match": {
      "name": "program_status",
      "status": "error"
    },
    "attention_kind": "error",
    "priority": 100,
    "fixture": "osc-error.json",
    "description": "osc error"
  },
  {
    "id": "pi-confirm",
    "source": "pi-ext",
    "match": {
      "name": "ui_prompt_start",
      "kind": "confirm"
    },
    "attention_kind": "blocked",
    "priority": 80,
    "fixture": "pi-confirm.json",
    "description": "pi confirm"
  },
  {
    "id": "pi-question",
    "source": "pi-ext",
    "match": {
      "name": "ui_prompt_start"
    },
    "attention_kind": "question",
    "priority": 70,
    "fixture": "pi-question.json",
    "description": "pi question"
  },
  {
    "id": "pi-tool-error",
    "source": "pi-ext",
    "match": {
      "name": "tool_execution_end",
      "isError": true
    },
    "attention_kind": "error",
    "priority": 100,
    "fixture": "pi-tool-error.json",
    "description": "pi tool error"
  },
  {
    "id": "pi-message-error",
    "source": "pi-ext",
    "match": {
      "name": "message_end",
      "stopReason": "error"
    },
    "attention_kind": "error",
    "priority": 100,
    "fixture": "pi-message-error.json",
    "description": "pi message error"
  },
  {
    "id": "pi-compact-error",
    "source": "pi-ext",
    "match": {
      "name": "session_compact_failed",
      // Missing flag remains compatible with older bridge records.
      "aborted": [false, undefined]
    },
    "attention_kind": "error",
    "priority": 100,
    "fixture": "pi-compact-error.json",
    "description": "pi compact error"
  },
  {
    "id": "pi-settled-error",
    "source": "pi-ext",
    "match": {
      "name": "agent_settled",
      "hadError": true
    },
    "attention_kind": "error",
    "priority": 100,
    "fixture": "pi-settled-error.json",
    "description": "pi settled error"
  },
  {
    "id": "pi-settled-question",
    "source": "pi-ext",
    "match": {
      "name": "agent_settled",
      "hadError": false,
      "aborted": false,
      "question": /\S\?["')*]*$/
    },
    "attention_kind": "question",
    "priority": 20,
    "fixture": "pi-settled-question.json",
    "description": "pi settled question"
  },
  {
    "id": "pi-settled",
    "source": "pi-ext",
    "match": {
      "name": "agent_settled",
      "hadError": false,
      "aborted": false
    },
    "attention_kind": "done",
    "priority": 10,
    "fixture": "pi-settled.json",
    "description": "pi settled"
  },
];

// removed: POLICIES, the watcher re-alert schedule (plan-orca-openbot §3).
export const IGNORED = [
  { source: 'pi-ext', name: 'ui_prompt_end' },
];
