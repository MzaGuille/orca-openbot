# Changelog

## 0.1.0

Primera versión. Puente entre Pi (Gentle Shell en Orca) y OpenBot, extraído de
`herdr-plugin-openbot` con solo lo que usa Orca.

- Extensión de Pi `pi/orca-openbot-attention.ts`: attention, bridge y órdenes. La identidad del pane es `orca:<ORCA_AGENT_SESSION_ID>`; sin esa variable no hace nada.
- Eventos firmados `orca.pane.<kind>` con `workspace_name = basename(cwd)`.
- CLI `orca-openbot`: `send` (solo bridge, con ack), `status`, `doctor`, `test-event`.
- `install.sh`: runtime en `~/.local/share/orca-openbot`, comando en `~/.local/bin/orca-openbot`, y migra `config.env` desde `~/.config/herdr-openbot/` si existe.
- Los `OPENBOT_HERDR_*` viejos se leen un release cuando el `OPENBOT_ORCA_*` nuevo no está definido.
