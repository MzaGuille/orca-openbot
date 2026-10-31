# Changelog

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
