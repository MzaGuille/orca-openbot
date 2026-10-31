# Changelog

## 0.2.1

- Consentimiento de revisión (#5): cuando `gentle_review` devuelve el sobre `consent_required`, el `agent_settled` siguiente llega como `orca.pane.question` con la señal `pi-review-consent`. `question.kind = review-consent`, `question.text` es el headline y `question.options` lleva las invocaciones `granted` y `declined` listas para correr. `next_hint.reply` dice que se corren en una shell con `GENTLE_PI_REVIEW_RELAY_CONTRACT=gentle-pi.review-relay/v1`; `orca-openbot send` no alcanza.
- El sobre se detecta en `tool_execution_end` de `gentle_review`, tanto el envuelto (`{outcome, consent, consent_binding}`) como el suelto. Solo se acepta una invocación `gentle-ai review start … --consent <respuesta>` que la redacción no altere.
- El bridge escribe `detail.consent` en el `done`. El espejo osc del mismo `agent_settled` no encola un segundo aviso.
- Nuevo fixture `tests/fixtures/review-consent-v3.json` (sobre real, schema `gentle-ai.review-integration.consent/v3`, contrato v2).

## 0.2.0

- Señal nueva `stalled`: un turno abierto sin `tool_start` ni `message_end` durante 15 minutos (configurable por entorno) con el heartbeat vivo avisa `orca.pane.stalled`. Un `tool_start` largo no cuenta como trabado. Cierra #6.
- El bridge escribe `ui_prompt_start` (kind y title) y `ui_prompt_end`, y un prompt con el turno abierto ya no se descarta.
- El payload completo de cada evento encolado queda en `~/.local/state/orca-openbot/events-full.jsonl`, con la misma redacción que el webhook y rotación por tamaño. `events.log` no cambia.
- `doctor` lista los panes con heartbeat vivo y sin evento encolado en los últimos minutos.


## 0.1.1

- Una pregunta en prosa de Pi bajo Gentle Shell llega como `question` y no como `done`. Un `agent_start` con el turno ya abierto ya no borra la pregunta capturada (`pi/bridge.js`, `pi/events.js`). Cierra #2.

## 0.1.0

Primera versión. Puente entre Pi (Gentle Shell en Orca) y OpenBot, extraído de
`herdr-plugin-openbot` con solo lo que usa Orca.

- Extensión de Pi `pi/orca-openbot-attention.ts`: attention, bridge y órdenes. La identidad del pane es `orca:<ORCA_AGENT_SESSION_ID>`; sin esa variable no hace nada.
- Eventos firmados `orca.pane.<kind>` con `workspace_name = basename(cwd)`.
- CLI `orca-openbot`: `send` (solo bridge, con ack), `status`, `doctor`, `test-event`.
- `install.sh`: runtime en `~/.local/share/orca-openbot`, comando en `~/.local/bin/orca-openbot`, y migra `config.env` desde `~/.config/herdr-openbot/` si existe.
- Los `OPENBOT_HERDR_*` viejos se leen un release cuando el `OPENBOT_ORCA_*` nuevo no está definido.
